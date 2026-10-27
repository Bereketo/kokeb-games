import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryWallet } from "@kokeb/wallet-contract/testing";
import { buildDeck, drawOrder, firstWinningCall } from "./cards.ts";
import { BingoEngine } from "./engine.ts";
import { MemoryBingoStore } from "./memory-store.ts";
import { BingoError, type BingoEvent } from "./types.ts";

const DECK_SEED = "test-deck";
const deck = buildDeck(DECK_SEED, 100);
const SEED = "seed-1"; // first game's draw
const order = drawOrder(SEED);
const winsAt = (card: number) => firstWinningCall(deck[card - 1]!, order);
const byWin = Array.from({ length: 100 }, (_, i) => i + 1).sort((a, b) => winsAt(a) - winsAt(b));

async function setup(opts: { stake?: bigint; store?: MemoryBingoStore; wallet?: MemoryWallet; startAt?: number } = {}) {
  let t = opts.startAt ?? 1_000_000;
  let seeds = 0;
  const store = opts.store ?? new MemoryBingoStore();
  const wallet = opts.wallet ?? new MemoryWallet();
  const events: BingoEvent[] = [];
  const engine = new BingoEngine({
    wallet,
    store,
    config: {
      deckSeed: DECK_SEED,
      rooms: [{ id: "r", name: "10 Birr", currency: "ETB", stake: opts.stake ?? 1_000n }],
      countdownMs: 30_000,
      drawIntervalMs: 3_000,
      claimWindowMs: 5_000,
      autoClaimAfterCalls: 3,
      commissionBps: 2_000,
      resultsMs: 8_000,
    },
    now: () => t,
    newSeed: () => `seed-${++seeds}`,
    log: () => {},
    retryBaseDelayMs: 1,
  });
  engine.on((e) => events.push(e));
  await engine.start();
  const advance = (ms: number) => {
    t += ms;
    engine.step();
  };
  /** Countdown runs out: the draw starts and ball 1 is called. */
  const toDraw = () => advance(30_000);
  /** Advance until `k` balls have been called. */
  const toCall = (k: number) => {
    while (engine.roomView("r").called.length < k) advance(3_000);
  };
  const pick = (playerId: string, cardNumber: number) => engine.pickCard({ playerId, label: playerId, roomId: "r", cardNumber });
  return { engine, wallet, store, events, advance, toDraw, toCall, pick, time: () => t };
}

async function expectBingoError(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(BingoError);
    expect((e as BingoError).code).toBe(code);
    return;
  }
  throw new Error(`expected BingoError ${code}`);
}

describe("bingo: lobby and cartelas", () => {
  it("the countdown starts only when two different players hold cartelas, and stops if one leaves", async () => {
    const { engine, wallet, pick } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", 1);
    await pick("a", 2);
    expect(engine.roomView("r").status).toBe("LOBBY"); // one player, two cards: not enough
    await pick("b", 3);
    expect(engine.roomView("r").status).toBe("COUNTDOWN");
    engine.releaseCard({ playerId: "b", roomId: "r", cardNumber: 3 });
    expect(engine.roomView("r").status).toBe("LOBBY");
  });

  it("charges the stake, locks the number, enforces the per-player limit", async () => {
    const { engine, wallet, pick } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", 7);
    expect(wallet.peek("a")).toBe(9_000n);
    await expectBingoError(pick("b", 7), "CARD_TAKEN");
    await pick("a", 8);
    await expectBingoError(pick("a", 9), "CARD_LIMIT");
    await expectBingoError(pick("b", 0), "INVALID_CARD");
    await expectBingoError(pick("b", 101), "INVALID_CARD");
    expect(engine.roomView("r").taken).toEqual([7, 8]);
  });

  it("refuses a cartela the player can't afford and frees the number", async () => {
    const { engine, wallet, pick } = await setup();
    wallet.addPlayer("a", 500n);
    await expectBingoError(pick("a", 5), "INSUFFICIENT_FUNDS");
    expect(engine.roomView("r").taken).toEqual([]);
    expect(wallet.peek("a")).toBe(500n);
  });

  it("a returned cartela is refunded and free again; once the draw starts it's too late", async () => {
    const { engine, wallet, pick, toDraw } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", 1);
    engine.releaseCard({ playerId: "a", roomId: "r", cardNumber: 1 });
    await engine.idle();
    expect(wallet.peek("a")).toBe(10_000n);
    await pick("b", 1); // someone else can take it now
    await pick("a", 2);
    toDraw();
    expect(() => engine.releaseCard({ playerId: "a", roomId: "r", cardNumber: 2 })).toThrow(/started/);
    await expectBingoError(pick("a", 3), "PICKING_CLOSED");
  });

  it("a cartela confirmed after the draw started is refunded and doesn't play", async () => {
    const { engine, wallet, pick, toDraw } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    wallet.addPlayer("late", 10_000n);
    await pick("a", 1);
    await pick("b", 2);
    const pending = pick("late", 3); // payment still in flight...
    toDraw(); // ...when the countdown ends
    await expectBingoError(pending, "PICKING_CLOSED");
    await engine.idle();
    expect(wallet.peek("late")).toBe(10_000n);
    expect(engine.roomView("r").taken).toEqual([1, 2]);
  });
});

describe("bingo: the draw and winning", () => {
  it("draws in the committed order; a valid BINGO wins the prize minus the 20% cut", async () => {
    const [winner, other] = [byWin[0]!, byWin[99]!];
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", winner);
    await pick("b", other);
    const room0 = engine.roomView("r");
    expect(room0.seedHash).toBe(createHash("sha256").update(SEED).digest("hex"));
    expect(room0.seed).toBeNull();

    toDraw();
    toCall(winsAt(winner));
    expect(engine.roomView("r").called).toEqual(order.slice(0, winsAt(winner)));
    const r = engine.claim({ playerId: "a", roomId: "r", cardNumber: winner });
    expect(r.valid).toBe(true);

    advance(5_000); // claim window closes
    const done = engine.roomView("r");
    expect(done.status).toBe("FINISHED");
    expect(done.seed).toBe(SEED); // revealed for verification
    expect(done.winners.map((w) => [w.cardNumber, w.payout])).toEqual([[winner, "1600"]]); // 2 × 10 ETB − 20%
    await engine.idle();
    expect(wallet.peek("a")).toBe(10_000n - 1_000n + 1_600n);
    expect(wallet.peek("b")).toBe(9_000n);
  });

  it("no balls are called during the claim window", async () => {
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", byWin[0]!);
    await pick("b", byWin[99]!);
    toDraw();
    toCall(winsAt(byWin[0]!));
    engine.claim({ playerId: "a", roomId: "r", cardNumber: byWin[0]! });
    const calls = engine.roomView("r").called.length;
    advance(4_000);
    expect(engine.roomView("r").called.length).toBe(calls);
  });

  it("a false BINGO knocks that cartela out for the game", async () => {
    const [early, late] = [byWin[0]!, byWin[99]!];
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", early);
    await pick("b", late);
    toDraw();
    expect(engine.claim({ playerId: "b", roomId: "r", cardNumber: late }).valid).toBe(false);
    expect(engine.playerCards("b")[0]!.status).toBe("ELIMINATED");
    toCall(winsAt(early));
    engine.claim({ playerId: "a", roomId: "r", cardNumber: early });
    advance(5_000);
    await engine.idle();
    expect(wallet.peek("a")).toBe(9_000n + 1_600n);
    expect(wallet.peek("b")).toBe(9_000n);
  });

  it("everyone who claims inside the window shares the prize; the first claimer gets the leftover santim", async () => {
    // Two cartelas that complete within two balls of each other, so both can still claim.
    let pair: [number, number] | null = null;
    for (let i = 0; i < 99 && !pair; i++) {
      const a = byWin[i]!, b = byWin[i + 1]!;
      if (winsAt(b) - winsAt(a) <= 2 && winsAt(a) > 0) pair = [a, b];
    }
    expect(pair).not.toBeNull();
    const [a, b] = pair!;
    const loser = byWin[99]!;
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup({ stake: 1_001n });
    for (const p of ["pa", "pb", "pc"]) wallet.addPlayer(p, 10_000n);
    await pick("pa", a);
    await pick("pb", b);
    await pick("pc", loser);
    toDraw();
    toCall(winsAt(b)); // a completed earlier but waited (still within 3 balls)
    expect(engine.claim({ playerId: "pb", roomId: "r", cardNumber: b }).valid).toBe(true);
    advance(2_000);
    expect(engine.claim({ playerId: "pa", roomId: "r", cardNumber: a }).valid).toBe(true);
    advance(3_000);
    // pot 3 × 10.01 = 30.03, cut 20% = 6.00 (floored), prize 24.03 -> 12.02 + 12.01
    const w = engine.roomView("r").winners;
    expect(w.map((x) => [x.cardNumber, x.payout])).toEqual([
      [b, "1202"],
      [a, "1201"],
    ]);
    await engine.idle();
    expect(wallet.peek("pb")).toBe(10_000n - 1_001n + 1_202n);
    expect(wallet.peek("pa")).toBe(10_000n - 1_001n + 1_201n);
  });

  it("a winning cartela nobody claims is claimed automatically after 3 more balls", async () => {
    const card = byWin[0]!;
    const { engine, wallet, pick, toDraw, toCall, advance, events } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", card);
    await pick("b", byWin[99]!);
    toDraw();
    toCall(winsAt(card) + 2);
    expect(engine.roomView("r").claimWindowEndsAt).toBeNull();
    toCall(winsAt(card) + 3);
    expect(events.some((e) => e.type === "bingo:claim" && e.cardNumber === card && e.auto)).toBe(true);
    advance(5_000);
    expect(engine.roomView("r").winners[0]!.auto).toBe(true);
    await engine.idle();
    expect(wallet.peek("a")).toBe(9_000n + 1_600n);
  });

  it("if every cartela is knocked out, all stakes are refunded and the house takes nothing", async () => {
    const { engine, wallet, pick, toDraw } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", byWin[98]!);
    await pick("b", byWin[99]!);
    toDraw();
    engine.claim({ playerId: "a", roomId: "r", cardNumber: byWin[98]! });
    engine.claim({ playerId: "b", roomId: "r", cardNumber: byWin[99]! });
    expect(engine.roomView("r").status).toBe("FINISHED");
    await engine.idle();
    expect(wallet.peek("a")).toBe(10_000n);
    expect(wallet.peek("b")).toBe(10_000n);
  });

  it("the next game opens after the results pause, with a new committed draw", async () => {
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", byWin[0]!);
    await pick("b", byWin[99]!);
    const firstGame = engine.roomView("r").gameId;
    toDraw();
    toCall(winsAt(byWin[0]!));
    engine.claim({ playerId: "a", roomId: "r", cardNumber: byWin[0]! });
    advance(5_000);
    advance(8_000);
    const next = engine.roomView("r");
    expect(next.gameId).not.toBe(firstGame);
    expect(next.status).toBe("LOBBY");
    expect(next.taken).toEqual([]);
    expect(next.seedHash).toBe(createHash("sha256").update("seed-2").digest("hex"));
  });
});

describe("bingo: failures", () => {
  it("a win is retried until the wallet accepts it, and paid once", async () => {
    const { engine, wallet, pick, toDraw, toCall, advance } = await setup();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    await pick("a", byWin[0]!);
    await pick("b", byWin[99]!);
    toDraw();
    toCall(winsAt(byWin[0]!));
    engine.claim({ playerId: "a", roomId: "r", cardNumber: byWin[0]! });
    wallet.failNext("credit", 3);
    advance(5_000);
    await engine.idle();
    expect(wallet.peek("a")).toBe(9_000n + 1_600n);
    expect(wallet.log.filter((l) => l.op === "credit" && !l.duplicate && l.amount === 1_600n).length).toBe(1);
  });

  it("after a restart mid-draw, the game is voided and every cartela refunded", async () => {
    const store = new MemoryBingoStore();
    const wallet = new MemoryWallet();
    wallet.addPlayer("a", 10_000n);
    wallet.addPlayer("b", 10_000n);
    const first = await setup({ store, wallet });
    await first.pick("a", 1);
    await first.pick("b", 2);
    first.toDraw();
    first.advance(3_000);
    await first.engine.idle();
    // --- crash: nothing else runs ---
    const second = await setup({ store, wallet });
    await second.engine.idle();
    expect([...store.games.values()].filter((g) => g.status === "VOID").length).toBe(1);
    expect(wallet.peek("a")).toBe(10_000n);
    expect(wallet.peek("b")).toBe(10_000n);
    expect(await store.unsettledCards()).toEqual([]);
    expect(second.engine.roomView("r").status).toBe("LOBBY");
  });
});
