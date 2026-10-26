/**
 * The crash game engine.
 *
 *   BETTING (config.bettingMs) ─▶ FLYING (multiplier climbs) ─▶ CRASHED (cooldown) ─▶ next round
 *
 * - Outcomes come only from the hash chain: round N's crash point is fixed
 *   by chain hash N and the public salt, before anyone bets.
 * - Time is the only input during flight. Cash-outs are judged by the
 *   server clock against the exact moment the round crashes, so a slow tick
 *   or a slow network can never turn a loss into a win (or the reverse).
 * - Money moves only through the WalletPort. The engine knows players only
 *   by opaque id: no Telegram, no platform code.
 *
 * Drive it by calling `step()` regularly (the game server does every ~50 ms);
 * tests drive it with a fake clock.
 */
import { randomUUID } from "node:crypto";
import { WalletError, type Currency, type WalletPort } from "@kokeb/wallet-contract";
import type { HashChain } from "../provably-fair/hash-chain.ts";
import { crashPointFromHash } from "./crash-point.ts";
import { msToReach, multiplierAt } from "./multiplier.ts";
import { SettlementQueue, betTxIds } from "./settlement.ts";
import {
  DEFAULT_CRASH_CONFIG,
  GameError,
  type BetRecord,
  type CrashConfig,
  type CrashEvent,
  type CrashStore,
  type PublicBet,
  type PublicRound,
  type RoundRecord,
} from "./types.ts";

export interface CrashEngineDeps {
  wallet: WalletPort;
  store: CrashStore;
  chain: HashChain;
  config: Partial<CrashConfig> & { salt: string };
  now?: () => number;
  log?: (msg: string, extra?: unknown) => void;
  /** Settlement retry timing (tests shorten it). */
  settlementBaseDelayMs?: number;
}

export interface PlaceBetInput {
  playerId: string;
  label: string;
  currency: Currency;
  slot: number;
  amount: bigint;
  autoCashout?: number | null;
}

type Listener = (event: CrashEvent) => void;

const HISTORY_SIZE = 30;

export class CrashEngine {
  readonly config: CrashConfig;
  private readonly wallet: WalletPort;
  private readonly store: CrashStore;
  private readonly chain: HashChain;
  private readonly now: () => number;
  private readonly log: (msg: string, extra?: unknown) => void;
  private readonly settlement: SettlementQueue;
  private readonly listeners = new Set<Listener>();

  private round: RoundRecord | null = null;
  /** Bets of the current round, keyed `${playerId}:${slot}`. */
  private bets = new Map<string, BetRecord>();
  private history: { number: number; crashPoint: number; hash: string }[] = [];
  private crashAtMs = 0;
  private writes: Promise<void> = Promise.resolve();
  private started = false;

  constructor(deps: CrashEngineDeps) {
    this.config = { ...DEFAULT_CRASH_CONFIG, ...deps.config };
    if (!this.config.salt) throw new Error("crash game salt is required");
    this.wallet = deps.wallet;
    this.store = deps.store;
    this.chain = deps.chain;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((msg, extra) => console.log(`[crash] ${msg}`, extra ?? ""));
    this.settlement = new SettlementQueue({
      wallet: this.wallet,
      gameId: this.config.gameId,
      baseDelayMs: deps.settlementBaseDelayMs,
      onSettled: (bet, balance) => {
        this.persistBet(bet);
        this.emit({ type: "balance", playerId: bet.playerId, currency: bet.currency, balance: balance.toString() });
      },
      onFailed: (bet, reason) => {
        this.log(`settlement failed for bet ${bet.id}, needs manual review`, reason);
        this.emit({ type: "settlement:failed", betId: bet.id, reason });
      },
    });
  }

  // ───────────────────────── lifecycle ─────────────────────────

  /** Recover from any previous run, then open the next round. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.recover();
    const recent = await this.store.recentRounds(HISTORY_SIZE);
    this.history = recent
      .filter((r) => r.status === "CRASHED")
      .map((r) => ({ number: r.number, crashPoint: r.crashPoint, hash: r.hash }));
    const last = await this.store.lastRound();
    this.openRound((last?.number ?? 0) + 1);
  }

  /** Advance the game to the current time. Call it often. */
  step(): void {
    const round = this.round;
    if (!round) return;
    const now = this.now();

    if (round.status === "BETTING" && now >= this.bettingEndsAt(round)) {
      round.status = "FLYING";
      round.flyingStartedAt = new Date(now);
      this.crashAtMs = now + msToReach(round.crashPoint);
      this.persistRound(round);
      this.emit({ type: "round:flying", round: this.publicRound(round), serverTime: now });
    }

    if (round.status === "FLYING") {
      this.processAutoCashouts(round, now);
      if (now >= this.crashAtMs) this.crash(round, now);
    }

    if (round.status === "CRASHED" && round.crashedAt && now >= round.crashedAt.getTime() + this.config.cooldownMs) {
      this.openRound(round.number + 1);
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stop retry timers and wait for pending DB writes and settlements. */
  async stop(): Promise<void> {
    await this.settlement.drain(5_000);
    this.settlement.stop();
    await this.writes;
  }

  /** Wait until all queued DB writes and wallet settlements are done (tests). */
  async idle(): Promise<void> {
    await this.settlement.drain();
    await this.writes;
  }

  // ───────────────────────── player actions ─────────────────────────

  async placeBet(input: PlaceBetInput): Promise<PublicBet> {
    const round = this.round;
    if (!round || round.status !== "BETTING" || this.now() >= this.bettingEndsAt(round)) {
      throw new GameError("BETTING_CLOSED", "betting is closed, wait for the next round");
    }
    if (input.slot !== 0 && input.slot !== 1) throw new GameError("INVALID_BET", "slot must be 0 or 1");
    if (input.amount < this.config.minBet || input.amount > this.config.maxBet) {
      throw new GameError("INVALID_BET", `bet must be between ${this.config.minBet} and ${this.config.maxBet}`);
    }
    const auto = input.autoCashout ?? null;
    if (auto !== null && (!Number.isInteger(auto) || auto < 101 || auto > 1_000_000)) {
      throw new GameError("INVALID_BET", "auto cash-out must be between 1.01x and 10000x");
    }
    const key = `${input.playerId}:${input.slot}`;
    if (this.bets.has(key)) throw new GameError("SLOT_TAKEN", "you already have a bet in this slot");

    const bet: BetRecord = {
      id: randomUUID(),
      roundId: round.id,
      playerId: input.playerId,
      label: input.label,
      slot: input.slot,
      currency: input.currency,
      amount: input.amount,
      autoCashout: auto,
      status: "PENDING",
      cashoutMultiplier: null,
      payout: null,
      settled: false,
      createdAt: new Date(this.now()),
    };
    this.bets.set(key, bet);
    // Persist BEFORE touching money: if we die mid-debit, recovery rolls it back.
    await this.persistBet(bet);

    let balance: bigint;
    try {
      balance = (
        await this.wallet.debit({
          txId: betTxIds(bet).bet,
          playerId: bet.playerId,
          currency: bet.currency,
          amount: bet.amount,
          gameId: this.config.gameId,
          roundId: bet.roundId,
        })
      ).balance;
    } catch (err) {
      if (err instanceof WalletError && !err.retryable) {
        // A definite refusal: no money moved.
        bet.status = "REJECTED";
        bet.settled = true;
        this.bets.delete(key);
        void this.persistBet(bet);
        if (err.code === "INSUFFICIENT_FUNDS") throw new GameError("INSUFFICIENT_FUNDS", "not enough balance");
        if (err.code === "PLAYER_BLOCKED") throw new GameError("PLAYER_BLOCKED", "your account can't place bets");
        throw new GameError("INVALID_BET", err.message);
      }
      // Unclear whether the debit happened: roll it back to be safe.
      this.abandon(bet, key);
      throw new GameError("WALLET_UNAVAILABLE", "could not place the bet, please try again");
    }

    // The debit can finish after betting closed: then the bet must not fly.
    if (this.round !== round || round.status !== "BETTING") {
      this.abandon(bet, key);
      throw new GameError("BETTING_CLOSED", "betting closed before your bet was confirmed; it was refunded");
    }

    bet.status = "PLACED";
    void this.persistBet(bet);
    this.emit({ type: "balance", playerId: bet.playerId, currency: bet.currency, balance: balance.toString() });
    this.emit({ type: "bet:placed", roundId: round.id, playerId: bet.playerId, bet: publicBet(bet) });
    return publicBet(bet);
  }

  async cancelBet(playerId: string, slot: number): Promise<void> {
    const round = this.round;
    const key = `${playerId}:${slot}`;
    const bet = this.bets.get(key);
    if (!round || !bet || bet.status !== "PLACED") throw new GameError("NO_ACTIVE_BET", "no bet to cancel");
    if (round.status !== "BETTING") throw new GameError("BETTING_CLOSED", "the round has started, you can only cash out");
    this.abandon(bet, key);
    this.emit({ type: "bet:cancelled", roundId: round.id, playerId: bet.playerId, bet: publicBet(bet) });
  }

  /** Cash out at the current multiplier. Decided instantly by the server clock. */
  cashout(playerId: string, slot: number): PublicBet {
    const round = this.round;
    const bet = this.bets.get(`${playerId}:${slot}`);
    if (!round || !bet || bet.status !== "PLACED") throw new GameError("NO_ACTIVE_BET", "no active bet to cash out");
    if (round.status !== "FLYING") throw new GameError("TOO_LATE", "the round is not flying");
    const now = this.now();
    if (now >= this.crashAtMs) throw new GameError("TOO_LATE", "too late, the round crashed");

    const elapsed = now - round.flyingStartedAt!.getTime();
    // Auto targets already passed are paid at the target, never above it.
    const auto = this.effectiveAutoTarget(bet);
    const m = Math.min(multiplierAt(elapsed), auto ?? Infinity);
    this.settleCashout(round, bet, Math.max(100, m));
    return publicBet(bet);
  }

  // ───────────────────────── views ─────────────────────────

  snapshot() {
    const round = this.round;
    const now = this.now();
    return {
      serverTime: now,
      round: round ? this.publicRound(round) : null,
      multiplier:
        round?.status === "FLYING" ? multiplierAt(now - round.flyingStartedAt!.getTime()) : round?.status === "CRASHED" ? round.crashPoint : 100,
      bets: [...this.bets.values()].filter((b) => b.status !== "PENDING" && b.status !== "REJECTED").map(publicBet),
      history: this.history.slice(0, HISTORY_SIZE),
      commitment: this.chain.commitment,
      config: {
        gameId: this.config.gameId,
        houseEdgeBps: this.config.houseEdgeBps,
        salt: this.config.salt,
        bettingMs: this.config.bettingMs,
        minBet: this.config.minBet.toString(),
        maxBet: this.config.maxBet.toString(),
        maxPayout: this.config.maxPayout.toString(),
      },
    };
  }

  playerBets(playerId: string): PublicBet[] {
    return [0, 1].flatMap((slot) => {
      const b = this.bets.get(`${playerId}:${slot}`);
      return b && b.status !== "REJECTED" ? [publicBet(b)] : [];
    });
  }

  // ───────────────────────── internals ─────────────────────────

  private openRound(number: number): void {
    const hash = this.chain.hashForGame(number);
    const round: RoundRecord = {
      id: randomUUID(),
      number,
      hash,
      crashPoint: crashPointFromHash(hash, this.config.salt, this.config.houseEdgeBps),
      status: "BETTING",
      bettingStartedAt: new Date(this.now()),
      flyingStartedAt: null,
      crashedAt: null,
    };
    this.round = round;
    this.bets = new Map();
    this.persistRound(round);
    this.emit({ type: "round:betting", round: this.publicRound(round) });
  }

  private processAutoCashouts(round: RoundRecord, now: number): void {
    const elapsed = now - round.flyingStartedAt!.getTime();
    for (const bet of this.bets.values()) {
      if (bet.status !== "PLACED") continue;
      const target = this.effectiveAutoTarget(bet);
      // Only targets strictly below the crash point win, and only once reached.
      if (target !== null && target < round.crashPoint && msToReach(target) <= elapsed) {
        this.settleCashout(round, bet, target);
      }
    }
  }

  /** The auto cash-out target, lowered if needed so the payout never exceeds maxPayout. */
  private effectiveAutoTarget(bet: BetRecord): number | null {
    const capTarget = Number((this.config.maxPayout * 100n) / bet.amount);
    if (bet.autoCashout === null) return capTarget;
    return Math.min(bet.autoCashout, capTarget);
  }

  private settleCashout(round: RoundRecord, bet: BetRecord, multiplier: number): void {
    bet.status = "CASHED_OUT";
    bet.cashoutMultiplier = multiplier;
    const payout = (bet.amount * BigInt(multiplier)) / 100n;
    bet.payout = payout > this.config.maxPayout ? this.config.maxPayout : payout;
    this.persistBet(bet);
    this.settlement.enqueue(bet);
    this.emit({ type: "bet:cashed", roundId: round.id, playerId: bet.playerId, bet: publicBet(bet) });
  }

  private crash(round: RoundRecord, now: number): void {
    round.status = "CRASHED";
    round.crashedAt = new Date(now);
    this.persistRound(round);
    for (const bet of this.bets.values()) {
      if (bet.status === "PLACED") {
        bet.status = "LOST";
        bet.payout = 0n;
        this.persistBet(bet);
        this.settlement.enqueue(bet);
      }
    }
    this.history.unshift({ number: round.number, crashPoint: round.crashPoint, hash: round.hash });
    this.history.length = Math.min(this.history.length, HISTORY_SIZE);
    this.emit({ type: "round:crashed", round: this.publicRound(round) });
  }

  /** Give the stake back (cancel, unclear debit, or confirmed too late). */
  private abandon(bet: BetRecord, key: string): void {
    bet.status = "CANCELLED";
    if (this.bets.get(key) === bet) this.bets.delete(key);
    this.persistBet(bet);
    this.settlement.enqueue(bet);
  }

  /**
   * After a restart: a round that was still betting or flying can't be
   * finished fairly (players couldn't cash out), so it is voided and every
   * open stake refunded. Cash-outs already won are still paid.
   */
  private async recover(): Promise<void> {
    const last = await this.store.lastRound();
    if (last && (last.status === "BETTING" || last.status === "FLYING")) {
      this.log(`voiding round ${last.number} interrupted by a restart`);
      last.status = "VOID";
      await this.store.saveRound(last);
      for (const bet of await this.store.betsForRound(last.id)) {
        if (bet.status === "PLACED" || bet.status === "PENDING") {
          bet.status = "CANCELLED";
          await this.store.saveBet(bet);
        }
      }
    }
    const unsettled = await this.store.unsettledBets();
    if (unsettled.length) this.log(`resuming settlement of ${unsettled.length} bet(s)`);
    for (const bet of unsettled) {
      if (bet.status === "PENDING" || bet.status === "PLACED") {
        bet.status = "CANCELLED";
        await this.store.saveBet(bet);
      }
      this.settlement.enqueue(bet);
    }
  }

  private bettingEndsAt(round: RoundRecord): number {
    return round.bettingStartedAt.getTime() + this.config.bettingMs;
  }

  private publicRound(round: RoundRecord): PublicRound {
    const done = round.status === "CRASHED";
    return {
      id: round.id,
      number: round.number,
      status: round.status,
      bettingEndsAt: this.bettingEndsAt(round),
      flyingStartedAt: round.flyingStartedAt?.getTime() ?? null,
      crashPoint: done ? round.crashPoint : null,
      hash: done ? round.hash : null,
    };
  }

  /** Writes are chained so they reach the store in order. */
  private persistRound(round: RoundRecord): Promise<void> {
    const snapshot = { ...round };
    return this.enqueueWrite(() => this.store.saveRound(snapshot));
  }

  private persistBet(bet: BetRecord): Promise<void> {
    const snapshot = { ...bet };
    return this.enqueueWrite(() => this.store.saveBet(snapshot));
  }

  private enqueueWrite(fn: () => Promise<void>): Promise<void> {
    const p = this.writes.then(fn).catch((err) => this.log("store write failed", err));
    this.writes = p;
    return p;
  }

  private emit(event: CrashEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        this.log("listener error", err);
      }
    }
  }
}

function publicBet(b: BetRecord): PublicBet {
  return {
    label: b.label,
    slot: b.slot,
    currency: b.currency,
    amount: b.amount.toString(),
    autoCashout: b.autoCashout,
    status: b.status,
    cashoutMultiplier: b.cashoutMultiplier,
    payout: b.payout?.toString() ?? null,
  };
}
