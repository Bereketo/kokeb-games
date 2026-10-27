/**
 * 75-ball bingo engine, Ethiopian style.
 *
 * Each room runs one game at a time:
 *
 *   LOBBY ─2+ players hold cartelas─▶ COUNTDOWN (30 s) ─▶ DRAWING (a ball every 3 s)
 *     ─first valid BINGO─▶ 5 s claim window ─▶ FINISHED (pay winners) ─8 s─▶ next game
 *
 * - Players pick numbered cartelas; card #N is fixed by the public deck seed.
 *   A picked number is locked for everyone else. Cartelas can be returned
 *   (refunded) until the draw starts.
 * - The draw order is a seeded shuffle; its hash is shown from the moment the
 *   game opens and the seed is revealed when it ends.
 * - Players tap BINGO. A false claim knocks that cartela out. Everyone with a
 *   valid claim inside the claim window shares the prize equally (any
 *   leftover santim goes to the first claimer). A winning cartela nobody
 *   claims is claimed automatically after `autoClaimAfterCalls` more balls.
 * - Prize = cartelas sold × stake − house cut, fixed when the draw starts.
 * - Money moves only through the WalletPort.
 *
 * Drive it with `step()` (the game server does every ~50 ms); tests use a fake clock.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { WalletError, type WalletPort } from "@kokeb/wallet-contract";
import { RetryQueue } from "../common/retry-queue.ts";
import { BALLS, buildDeck, drawOrder, seedHash, winningPattern, type Card } from "./cards.ts";
import {
  BingoError,
  DEFAULT_BINGO_CONFIG,
  type BingoCardRecord,
  type BingoConfig,
  type BingoEvent,
  type BingoGameRecord,
  type BingoRoomConfig,
  type BingoStore,
  type PublicBingoRoom,
} from "./types.ts";

export interface BingoEngineDeps {
  wallet: WalletPort;
  store: BingoStore;
  config: Partial<BingoConfig> & { deckSeed: string };
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
  /** Settlement retry timing (tests shorten it). */
  retryBaseDelayMs?: number;
  /** Deterministic seeds for tests. */
  newSeed?: () => string;
}

interface Room {
  config: BingoRoomConfig;
  game: BingoGameRecord;
  order: number[];
  /** Cartelas in this game by number (not cancelled/rejected). */
  cards: Map<number, BingoCardRecord>;
  /** Call index at which each held cartela first had a winning pattern. */
  completedAt: Map<number, number>;
  claims: { cardNumber: number; auto: boolean }[];
  claimWindowEndsAt: number | null;
  nextCallAt: number | null;
}

type Listener = (event: BingoEvent) => void;

const ACTIVE = new Set(["PENDING", "HELD"]);

export class BingoEngine {
  readonly config: BingoConfig;
  readonly deck: Card[];
  private readonly wallet: WalletPort;
  private readonly store: BingoStore;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly newSeed: () => string;
  private readonly settlement: RetryQueue<BingoCardRecord>;
  private readonly listeners = new Set<Listener>();
  private readonly rooms = new Map<string, Room>();
  private writes: Promise<void> = Promise.resolve();

  constructor(deps: BingoEngineDeps) {
    this.config = { ...DEFAULT_BINGO_CONFIG, ...deps.config };
    if (!this.config.deckSeed) throw new Error("bingo deck seed is required");
    this.deck = buildDeck(this.config.deckSeed, this.config.cardsPerRoom);
    this.wallet = deps.wallet;
    this.store = deps.store;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((msg, extra) => console.log(`[bingo] ${msg}`, extra ?? ""));
    this.newSeed = deps.newSeed ?? (() => randomBytes(32).toString("hex"));
    this.settlement = new RetryQueue<BingoCardRecord>({
      key: (c) => c.id,
      baseDelayMs: deps.retryBaseDelayMs,
      run: (c) => this.settle(c),
      onFailed: (c, reason) => {
        this.log(`settlement failed for cartela ${c.id}, needs manual review`, reason);
        this.emit({ type: "settlement:failed", cardId: c.id, reason });
      },
    });
  }

  // ───────────────────────── lifecycle ─────────────────────────

  async start(): Promise<void> {
    // Games interrupted by a restart can't be finished fairly: void them and refund.
    for (const game of await this.store.openGames()) {
      this.log(`voiding bingo game ${game.id} (room ${game.roomId}) interrupted by a restart`);
      game.status = "VOID";
      game.finishedAt = new Date(this.now());
      await this.store.saveGame(game);
    }
    for (const card of await this.store.unsettledCards()) {
      if (card.status === "PENDING" || card.status === "HELD") {
        card.status = "CANCELLED";
        await this.store.saveCard(card);
      }
      this.settlement.enqueue(card);
    }
    for (const rc of this.config.rooms) this.openGame(rc);
  }

  step(): void {
    const now = this.now();
    for (const room of this.rooms.values()) {
      const g = room.game;
      if (g.status === "COUNTDOWN" && g.countdownEndsAt && now >= g.countdownEndsAt.getTime()) this.startDraw(room, now);

      if (g.status === "DRAWING") {
        if (room.claimWindowEndsAt !== null) {
          if (now >= room.claimWindowEndsAt) this.finish(room, now);
        } else {
          while (room.nextCallAt !== null && now >= room.nextCallAt && g.calls < BALLS && room.claimWindowEndsAt === null) {
            const at = room.nextCallAt;
            room.nextCallAt += this.config.drawIntervalMs;
            this.callBall(room, at);
            if (g.status !== "DRAWING") break;
          }
        }
      }

      if ((g.status === "FINISHED" || g.status === "VOID") && g.finishedAt && now >= g.finishedAt.getTime() + this.config.resultsMs) {
        this.openGame(room.config);
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async idle(): Promise<void> {
    await this.settlement.drain();
    await this.writes;
  }

  async stop(): Promise<void> {
    await this.settlement.drain(5_000);
    this.settlement.stop();
    await this.writes;
  }

  // ───────────────────────── player actions ─────────────────────────

  async pickCard(input: { playerId: string; label: string; roomId: string; cardNumber: number }): Promise<void> {
    const room = this.room(input.roomId);
    const game = room.game;
    this.requirePicking(room);
    const n = input.cardNumber;
    if (!Number.isInteger(n) || n < 1 || n > this.config.cardsPerRoom) {
      throw new BingoError("INVALID_CARD", `pick a cartela between 1 and ${this.config.cardsPerRoom}`);
    }
    if (room.cards.has(n)) throw new BingoError("CARD_TAKEN", `cartela ${n} is already taken`);
    const mine = [...room.cards.values()].filter((c) => c.playerId === input.playerId && ACTIVE.has(c.status)).length;
    if (mine >= this.config.maxCardsPerPlayer) {
      throw new BingoError("CARD_LIMIT", `you can hold up to ${this.config.maxCardsPerPlayer} cartelas per game`);
    }

    const card: BingoCardRecord = {
      id: randomUUID(),
      gameId: game.id,
      roomId: room.config.id,
      playerId: input.playerId,
      label: input.label,
      cardNumber: n,
      currency: room.config.currency,
      stake: room.config.stake,
      status: "PENDING",
      payout: null,
      settled: false,
      createdAt: new Date(this.now()),
    };
    room.cards.set(n, card); // locked for everyone else from this moment
    this.emitRoom(room);
    await this.persistCard(card); // before money moves: recovery can always refund it

    let balance: bigint;
    try {
      balance = (
        await this.wallet.debit({
          txId: `${card.id}:bet`,
          playerId: card.playerId,
          currency: card.currency,
          amount: card.stake,
          gameId: this.config.gameId,
          roundId: game.id,
        })
      ).balance;
    } catch (err) {
      if (err instanceof WalletError && !err.retryable) {
        card.status = "REJECTED";
        card.settled = true;
        if (room.cards.get(n) === card) room.cards.delete(n);
        void this.persistCard(card);
        this.emitRoom(room);
        if (err.code === "INSUFFICIENT_FUNDS") throw new BingoError("INSUFFICIENT_FUNDS", "not enough balance");
        if (err.code === "PLAYER_BLOCKED") throw new BingoError("PLAYER_BLOCKED", "your account can't play");
        throw new BingoError("INVALID_CARD", err.message);
      }
      this.abandon(room, card);
      this.emitRoom(room);
      throw new BingoError("WALLET_UNAVAILABLE", "could not buy the cartela, please try again");
    }

    if (room.game !== game || (game.status !== "LOBBY" && game.status !== "COUNTDOWN")) {
      this.abandon(room, card);
      if (room.game === game) this.emitRoom(room);
      throw new BingoError("PICKING_CLOSED", "the draw started before your cartela was confirmed; it was refunded");
    }

    card.status = "HELD";
    void this.persistCard(card);
    this.updateCountdown(room);
    this.emit({ type: "balance", playerId: card.playerId, currency: card.currency, balance: balance.toString() });
    this.emitCard(card);
    this.emitRoom(room);
  }

  /** Give a cartela back before the draw starts (refunded). */
  releaseCard(input: { playerId: string; roomId: string; cardNumber: number }): void {
    const room = this.room(input.roomId);
    this.requirePicking(room);
    const card = room.cards.get(input.cardNumber);
    if (!card || card.playerId !== input.playerId || card.status !== "HELD") throw new BingoError("NOT_YOUR_CARD", "that isn't your cartela");
    this.abandon(room, card);
    this.updateCountdown(room);
    this.emitCard(card);
    this.emitRoom(room);
  }

  /** The player taps BINGO for one of their cartelas. Returns whether it was valid. */
  claim(input: { playerId: string; roomId: string; cardNumber: number }): { valid: boolean; pattern: string | null } {
    const room = this.room(input.roomId);
    if (room.game.status !== "DRAWING") throw new BingoError("NOT_DRAWING", "there's no game being drawn right now");
    const card = room.cards.get(input.cardNumber);
    if (!card || card.playerId !== input.playerId) throw new BingoError("NOT_YOUR_CARD", "that isn't your cartela");
    if (card.status !== "HELD") return { valid: false, pattern: null }; // already out
    if (room.claims.some((c) => c.cardNumber === card.cardNumber)) {
      return { valid: true, pattern: winningPattern(this.deck[card.cardNumber - 1]!, this.called(room))?.name ?? null };
    }
    return this.addClaim(room, card, false, this.now());
  }

  // ───────────────────────── views ─────────────────────────

  roomsView(): PublicBingoRoom[] {
    return [...this.rooms.values()].map((r) => this.publicRoom(r));
  }

  roomView(roomId: string): PublicBingoRoom {
    return this.publicRoom(this.room(roomId));
  }

  /** The player's cartelas in the current games. */
  playerCards(playerId: string) {
    const out: { roomId: string; gameId: string; cardNumber: number; status: string; payout: string | null }[] = [];
    for (const r of this.rooms.values()) {
      for (const c of r.cards.values()) {
        if (c.playerId === playerId && c.status !== "PENDING") {
          out.push({ roomId: r.config.id, gameId: r.game.id, cardNumber: c.cardNumber, status: c.status, payout: c.payout?.toString() ?? null });
        }
      }
    }
    return out;
  }

  publicConfig() {
    const c = this.config;
    return {
      gameId: c.gameId,
      deckSeed: c.deckSeed,
      cardsPerRoom: c.cardsPerRoom,
      maxCardsPerPlayer: c.maxCardsPerPlayer,
      minPlayers: c.minPlayers,
      countdownMs: c.countdownMs,
      drawIntervalMs: c.drawIntervalMs,
      claimWindowMs: c.claimWindowMs,
      autoClaimAfterCalls: c.autoClaimAfterCalls,
      commissionBps: c.commissionBps,
      rooms: c.rooms.map((r) => ({ id: r.id, name: r.name, currency: r.currency, stake: r.stake.toString() })),
    };
  }

  // ───────────────────────── internals ─────────────────────────

  private openGame(rc: BingoRoomConfig): void {
    const seed = this.newSeed();
    const game: BingoGameRecord = {
      id: randomUUID(),
      roomId: rc.id,
      seed,
      seedHash: seedHash(seed),
      status: "LOBBY",
      createdAt: new Date(this.now()),
      countdownEndsAt: null,
      startedAt: null,
      finishedAt: null,
      calls: 0,
      pot: 0n,
      commission: 0n,
      prize: 0n,
      winners: [],
    };
    const room: Room = {
      config: rc,
      game,
      order: drawOrder(seed),
      cards: new Map(),
      completedAt: new Map(),
      claims: [],
      claimWindowEndsAt: null,
      nextCallAt: null,
    };
    this.rooms.set(rc.id, room);
    this.persistGame(game);
    this.emitRoom(room);
  }

  private updateCountdown(room: Room): void {
    const g = room.game;
    const players = this.distinctHolders(room);
    if (g.status === "LOBBY" && players >= this.config.minPlayers) {
      g.status = "COUNTDOWN";
      g.countdownEndsAt = new Date(this.now() + this.config.countdownMs);
      this.persistGame(g);
    } else if (g.status === "COUNTDOWN" && players < this.config.minPlayers) {
      g.status = "LOBBY";
      g.countdownEndsAt = null;
      this.persistGame(g);
    }
  }

  private startDraw(room: Room, now: number): void {
    const g = room.game;
    const held = [...room.cards.values()].filter((c) => c.status === "HELD");
    if (this.distinctHolders(room) < this.config.minPlayers) {
      g.status = "LOBBY";
      g.countdownEndsAt = null;
      this.persistGame(g);
      this.emitRoom(room);
      return;
    }
    g.status = "DRAWING";
    g.startedAt = new Date(now);
    g.pot = room.config.stake * BigInt(held.length);
    g.commission = (g.pot * BigInt(this.config.commissionBps)) / 10_000n;
    g.prize = g.pot - g.commission;
    room.nextCallAt = now; // first ball right away
    this.persistGame(g);
    this.emitRoom(room);
  }

  private callBall(room: Room, at: number): void {
    const g = room.game;
    g.calls += 1;
    const ball = room.order[g.calls - 1]!;
    const called = this.called(room);
    this.emit({ type: "bingo:ball", roomId: room.config.id, gameId: g.id, ball, index: g.calls });

    for (const c of room.cards.values()) {
      if (c.status === "HELD" && !room.completedAt.has(c.cardNumber) && winningPattern(this.deck[c.cardNumber - 1]!, called)) {
        room.completedAt.set(c.cardNumber, g.calls);
      }
    }
    // Safety net: claim for players who missed it (bad connection, not looking).
    for (const c of room.cards.values()) {
      const done = room.completedAt.get(c.cardNumber);
      if (c.status !== "HELD" || done === undefined || room.claims.some((x) => x.cardNumber === c.cardNumber)) continue;
      if (g.calls - done >= this.config.autoClaimAfterCalls || g.calls >= BALLS) this.addClaim(room, c, true, at);
    }
    this.persistGame(g);
    if (g.calls >= BALLS && room.claimWindowEndsAt === null && g.status === "DRAWING") this.finish(room, at);
  }

  private addClaim(room: Room, card: BingoCardRecord, auto: boolean, at: number): { valid: boolean; pattern: string | null } {
    const g = room.game;
    const pattern = winningPattern(this.deck[card.cardNumber - 1]!, this.called(room));
    this.emit({ type: "bingo:claim", roomId: room.config.id, gameId: g.id, cardNumber: card.cardNumber, label: card.label, valid: !!pattern, auto });
    if (!pattern) {
      card.status = "ELIMINATED";
      card.payout = 0n;
      void this.persistCard(card);
      this.emitCard(card);
      // If every cartela is out, nobody can win: refund everyone.
      if (![...room.cards.values()].some((c) => c.status === "HELD")) this.finish(room, at);
      else this.emitRoom(room);
      return { valid: false, pattern: null };
    }
    room.claims.push({ cardNumber: card.cardNumber, auto });
    if (room.claimWindowEndsAt === null) room.claimWindowEndsAt = at + this.config.claimWindowMs;
    this.emitRoom(room);
    return { valid: true, pattern: pattern.name };
  }

  private finish(room: Room, now: number): void {
    const g = room.game;
    const called = this.called(room);
    const cards = [...room.cards.values()];

    if (room.claims.length === 0) {
      // No possible winner (every cartela knocked out): refund all stakes, no cut.
      g.commission = 0n;
      g.prize = 0n;
      for (const c of cards) {
        if (c.status === "HELD" || c.status === "ELIMINATED") {
          this.abandon(room, c, false);
          this.emitCard(c);
        }
      }
    } else {
      const n = BigInt(room.claims.length);
      const share = g.prize / n;
      const leftover = g.prize - share * n;
      g.winners = room.claims.map((cl, i) => {
        const card = room.cards.get(cl.cardNumber)!;
        const p = winningPattern(this.deck[card.cardNumber - 1]!, called)!;
        const payout = share + (i === 0 ? leftover : 0n);
        card.status = "WON";
        card.payout = payout;
        return { cardNumber: card.cardNumber, playerId: card.playerId, label: card.label, pattern: p.name, cells: [...p.cells], payout, auto: cl.auto };
      });
      for (const c of cards) {
        if (c.status === "HELD") {
          c.status = "LOST";
          c.payout = 0n;
        }
        if (c.status === "WON" || c.status === "LOST" || c.status === "ELIMINATED") {
          void this.persistCard(c);
          this.settlement.enqueue(c);
          this.emitCard(c);
        }
      }
    }
    g.status = "FINISHED";
    g.finishedAt = new Date(now);
    room.claimWindowEndsAt = null;
    room.nextCallAt = null;
    this.persistGame(g);
    this.emitRoom(room);
  }

  /** Refund a cartela: cancel and roll back its stake. */
  private abandon(room: Room, card: BingoCardRecord, free = true): void {
    card.status = "CANCELLED";
    card.payout = null;
    if (free && room.cards.get(card.cardNumber) === card) room.cards.delete(card.cardNumber);
    void this.persistCard(card);
    this.settlement.enqueue(card);
  }

  private async settle(card: BingoCardRecord): Promise<void> {
    const common = { playerId: card.playerId, currency: card.currency, gameId: this.config.gameId, roundId: card.gameId };
    let balance: bigint;
    switch (card.status) {
      case "WON":
      case "LOST":
      case "ELIMINATED":
        balance = (await this.wallet.credit({ ...common, txId: `${card.id}:win`, amount: card.payout ?? 0n })).balance;
        break;
      case "CANCELLED":
      case "PENDING":
        balance = (await this.wallet.rollback({ ...common, txId: `${card.id}:rb`, originalTxId: `${card.id}:bet` })).balance;
        break;
      default:
        return;
    }
    card.settled = true;
    await this.persistCard(card);
    this.emit({ type: "balance", playerId: card.playerId, currency: card.currency, balance: balance.toString() });
  }

  private requirePicking(room: Room): void {
    const g = room.game;
    const open = g.status === "LOBBY" || (g.status === "COUNTDOWN" && (!g.countdownEndsAt || this.now() < g.countdownEndsAt.getTime()));
    if (!open) throw new BingoError("PICKING_CLOSED", "this game has started; pick a cartela for the next one");
  }

  private room(roomId: string): Room {
    const r = this.rooms.get(roomId);
    if (!r) throw new BingoError("ROOM_NOT_FOUND", "no such room");
    return r;
  }

  private called(room: Room): Set<number> {
    return new Set(room.order.slice(0, room.game.calls));
  }

  private distinctHolders(room: Room): number {
    return new Set([...room.cards.values()].filter((c) => c.status === "HELD").map((c) => c.playerId)).size;
  }

  private publicRoom(room: Room): PublicBingoRoom {
    const g = room.game;
    const done = g.status === "FINISHED" || g.status === "VOID";
    const held = [...room.cards.values()].filter((c) => c.status === "HELD").length;
    const pot = room.config.stake * BigInt(held);
    const prize = g.status === "LOBBY" || g.status === "COUNTDOWN" ? pot - (pot * BigInt(this.config.commissionBps)) / 10_000n : g.prize;
    return {
      roomId: room.config.id,
      name: room.config.name,
      currency: room.config.currency,
      stake: room.config.stake.toString(),
      gameId: g.id,
      status: g.status,
      seedHash: g.seedHash,
      countdownEndsAt: g.countdownEndsAt?.getTime() ?? null,
      claimWindowEndsAt: room.claimWindowEndsAt,
      nextCallAt: g.status === "DRAWING" ? room.nextCallAt : null,
      taken: [...room.cards.keys()].sort((a, b) => a - b),
      players: this.distinctHolders(room),
      prize: prize.toString(),
      called: room.order.slice(0, g.calls),
      winners: g.winners.map((w) => ({ cardNumber: w.cardNumber, label: w.label, pattern: w.pattern, cells: w.cells, payout: w.payout.toString(), auto: w.auto })),
      seed: done ? g.seed : null,
    };
  }

  private persistGame(game: BingoGameRecord): void {
    const snap = { ...game, winners: game.winners.map((w) => ({ ...w })) };
    this.enqueueWrite(() => this.store.saveGame(snap));
  }

  private persistCard(card: BingoCardRecord): Promise<void> {
    const snap = { ...card };
    return this.enqueueWrite(() => this.store.saveCard(snap));
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const p = this.writes.then(fn).catch((err) => this.log("store write failed", err));
    this.writes = p;
    return p;
  }

  private emitRoom(room: Room): void {
    this.emit({ type: "bingo:room", room: this.publicRoom(room) });
  }

  private emitCard(card: BingoCardRecord): void {
    this.emit({
      type: "bingo:card",
      roomId: card.roomId,
      gameId: card.gameId,
      playerId: card.playerId,
      cardNumber: card.cardNumber,
      status: card.status,
      payout: card.payout?.toString() ?? null,
    });
  }

  private emit(event: BingoEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.log("listener error", err);
      }
    }
  }
}
