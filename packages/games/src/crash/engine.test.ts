import { describe, expect, it } from "vitest";
import { MemoryWallet } from "@kokeb/wallet-contract/testing";
import { HashChain } from "../provably-fair/hash-chain.ts";
import { crashPointFromHash } from "./crash-point.ts";
import { CrashEngine } from "./engine.ts";
import { MemoryCrashStore } from "./memory-store.ts";
import { msToReach } from "./multiplier.ts";
import { GameError, type CrashEvent } from "./types.ts";

const SECRET = "engine-test-secret-0123456789abcdefghijklmn";
const SALT = "test-salt";
const chain = HashChain.fromSecret(SECRET, 2_000);
const crashOf = (game: number) => crashPointFromHash(chain.hashForGame(game), SALT, 300);

/** First game number >= from whose crash point satisfies `pred`. */
function findGame(pred: (crash: number) => boolean, from = 1): number {
  for (let g = from; g <= chain.length; g++) if (pred(crashOf(g))) return g;
  throw new Error("no such game in test chain");
}

async function setup(opts: { startAtGame?: number; store?: MemoryCrashStore; wallet?: MemoryWallet } = {}) {
  let t = 1_000_000;
  const store = opts.store ?? new MemoryCrashStore();
  if (opts.startAtGame && opts.startAtGame > 1) {
    // Pretend previous rounds were played so the engine opens the game we want.
    await store.saveRound({
      id: "previous",
      number: opts.startAtGame - 1,
      hash: chain.hashForGame(opts.startAtGame - 1),
      crashPoint: crashOf(opts.startAtGame - 1),
      status: "CRASHED",
      bettingStartedAt: new Date(0),
      flyingStartedAt: new Date(0),
      crashedAt: new Date(0),
    });
  }
  const wallet = opts.wallet ?? new MemoryWallet();
  const events: CrashEvent[] = [];
  const engine = new CrashEngine({
    wallet,
    store,
    chain,
    config: { salt: SALT, bettingMs: 5_000, cooldownMs: 2_000 },
    now: () => t,
    log: () => {},
    settlementBaseDelayMs: 1,
  });
  engine.on((e) => events.push(e));
  await engine.start();
  const advance = (ms: number) => {
    t += ms;
    engine.step();
  };
  const toFlight = () => advance(5_000);
  /** Move the clock WITHOUT a tick, as if a request arrives between ticks. */
  const skew = (ms: number) => {
    t += ms;
  };
  return { engine, wallet, store, events, advance, toFlight, skew };
}

const bet = (playerId: string, amount: bigint, extra: { slot?: number; autoCashout?: number; currency?: "ETB" | "DEMO" } = {}) => ({
  playerId,
  label: "p***1",
  currency: extra.currency ?? ("ETB" as const),
  slot: extra.slot ?? 0,
  amount,
  autoCashout: extra.autoCashout ?? null,
});

async function expectGameError(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(GameError);
    expect((e as GameError).code).toBe(code);
    return;
  }
  throw new Error(`expected GameError ${code}`);
}

describe("crash engine: round cycle", () => {
  it("opens betting, flies, crashes at the chain's crash point, then opens the next round", async () => {
    const game = findGame((c) => c >= 200);
    const { engine, events, advance, toFlight } = await setup({ startAtGame: game });
    expect(engine.snapshot().round?.status).toBe("BETTING");
    expect(engine.snapshot().round?.crashPoint).toBeNull(); // secret while betting

    toFlight();
    expect(engine.snapshot().round?.status).toBe("FLYING");
    advance(msToReach(crashOf(game)) - 1);
    expect(engine.snapshot().round?.status).toBe("FLYING");
    advance(1);
    const snap = engine.snapshot();
    expect(snap.round?.status).toBe("CRASHED");
    expect(snap.round?.crashPoint).toBe(crashOf(game));
    expect(snap.round?.hash).toBe(chain.hashForGame(game)); // revealed for verification

    advance(2_000);
    expect(engine.snapshot().round?.number).toBe(game + 1);
    expect(events.map((e) => e.type)).toEqual(["round:betting", "round:flying", "round:crashed", "round:betting"]);
  });

  it("a 1.00x round crashes the moment it starts", async () => {
    const game = findGame((c) => c === 100);
    const { engine, toFlight } = await setup({ startAtGame: game });
    toFlight();
    expect(engine.snapshot().round?.status).toBe("CRASHED");
  });
});

describe("crash engine: bets and cash-outs", () => {
  it("a manual cash-out pays stake x multiplier at that instant", async () => {
    const game = findGame((c) => c >= 300);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n));
    expect(wallet.peek("p1")).toBe(9_000n);

    toFlight();
    advance(msToReach(200)); // exactly 2.00x
    const result = engine.cashout("p1", 0);
    expect(result.cashoutMultiplier).toBe(200);
    expect(result.payout).toBe("2000");
    await engine.idle();
    expect(wallet.peek("p1")).toBe(11_000n);
  });

  it("a bet left in when the round crashes is lost, and the wallet round is closed with a 0 credit", async () => {
    const game = findGame((c) => c >= 150 && c < 1000);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n));
    toFlight();
    advance(msToReach(crashOf(game)));
    await engine.idle();
    expect(wallet.peek("p1")).toBe(9_000n);
    expect(wallet.log.some((l) => l.op === "credit" && l.amount === 0n)).toBe(true);
  });

  it("cash-out at the exact crash instant is too late; one millisecond before wins", async () => {
    const game = findGame((c) => c >= 200 && c < 5000);
    const crashMs = msToReach(crashOf(game));

    const a = await setup({ startAtGame: game });
    a.wallet.addPlayer("p1", 10_000n);
    await a.engine.placeBet(bet("p1", 1_000n));
    a.toFlight();
    a.advance(crashMs - 1);
    expect(a.engine.cashout("p1", 0).status).toBe("CASHED_OUT");

    const b = await setup({ startAtGame: game });
    b.wallet.addPlayer("p1", 10_000n);
    await b.engine.placeBet(bet("p1", 1_000n));
    b.toFlight();
    b.advance(crashMs - 1);
    b.skew(1); // the crash instant arrives, but no tick has run yet
    await expectGameError(() => b.engine.cashout("p1", 0), "TOO_LATE");
  });

  it("auto cash-out pays exactly the target, even if the server tick runs late", async () => {
    const game = findGame((c) => c >= 300);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n, { autoCashout: 150 }));
    toFlight();
    advance(msToReach(250)); // one late tick, far past 1.50x
    const mine = engine.playerBets("p1")[0]!;
    expect(mine.status).toBe("CASHED_OUT");
    expect(mine.cashoutMultiplier).toBe(150);
    await engine.idle();
    expect(wallet.peek("p1")).toBe(10_500n);
  });

  it("an auto target equal to the crash point loses", async () => {
    const game = findGame((c) => c >= 150 && c < 1000);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n, { autoCashout: crashOf(game) }));
    toFlight();
    advance(msToReach(crashOf(game)) + 10);
    expect(engine.playerBets("p1")[0]!.status).toBe("LOST");
  });

  it("two bet slots work independently", async () => {
    const game = findGame((c) => c >= 300);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n, { slot: 0, autoCashout: 120 }));
    await engine.placeBet(bet("p1", 500n, { slot: 1 }));
    toFlight();
    advance(msToReach(250));
    engine.cashout("p1", 1);
    await engine.idle();
    // slot 0: 1000 -> 1200 ; slot 1: 500 -> 1250
    expect(wallet.peek("p1")).toBe(10_000n - 1_500n + 1_200n + 1_250n);
  });

  it("demo bets use demo money only", async () => {
    const game = findGame((c) => c >= 300);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n, { currency: "DEMO", autoCashout: 200 }));
    toFlight();
    advance(msToReach(250));
    await engine.idle();
    expect(wallet.peek("p1", "DEMO")).toBe(wallet.demoGrant + 1_000n);
    expect(wallet.peek("p1", "ETB")).toBe(10_000n);
  });

  it("the max payout caps a win by cashing out automatically", async () => {
    const game = findGame((c) => c >= 1000, 2);
    const store = new MemoryCrashStore();
    const wallet = new MemoryWallet();
    let t = 0;
    await store.saveRound({ id: "prev", number: game - 1, hash: chain.hashForGame(game - 1), crashPoint: 100, status: "CRASHED", bettingStartedAt: new Date(0), flyingStartedAt: new Date(0), crashedAt: new Date(0) });
    const engine = new CrashEngine({ wallet, store, chain, config: { salt: SALT, bettingMs: 1_000, maxPayout: 5_000n }, now: () => t, log: () => {} });
    await engine.start();
    wallet.addPlayer("p1", 10_000n);
    await engine.placeBet(bet("p1", 1_000n));
    t += 1_000;
    engine.step();
    t += msToReach(900);
    engine.step();
    const mine = engine.playerBets("p1")[0]!;
    expect(mine.cashoutMultiplier).toBe(500);
    expect(mine.payout).toBe("5000");
  });
});

describe("crash engine: rules and failures", () => {
  it("validates bets and refuses them outside the betting phase", async () => {
    const game = findGame((c) => c >= 200);
    const { engine, wallet, toFlight } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 10_000n);
    await expectGameError(engine.placeBet(bet("p1", 50n)), "INVALID_BET");
    await expectGameError(engine.placeBet(bet("p1", 100n, { slot: 2 })), "INVALID_BET");
    await expectGameError(engine.placeBet(bet("p1", 100n, { autoCashout: 100 })), "INVALID_BET");
    await engine.placeBet(bet("p1", 100n));
    await expectGameError(engine.placeBet(bet("p1", 100n)), "SLOT_TAKEN");
    toFlight();
    await expectGameError(engine.placeBet(bet("p1", 100n, { slot: 1 })), "BETTING_CLOSED");
  });

  it("refuses a bet bigger than the balance without moving money", async () => {
    const { engine, wallet } = await setup();
    wallet.addPlayer("p1", 500n);
    await expectGameError(engine.placeBet(bet("p1", 1_000n)), "INSUFFICIENT_FUNDS");
    expect(wallet.peek("p1")).toBe(500n);
    // the slot is free again
    await engine.placeBet(bet("p1", 500n));
  });

  it("cancelling during betting refunds the stake", async () => {
    const { engine, wallet } = await setup();
    wallet.addPlayer("p1", 1_000n);
    await engine.placeBet(bet("p1", 400n));
    await engine.cancelBet("p1", 0);
    await engine.idle();
    expect(wallet.peek("p1")).toBe(1_000n);
  });

  it("a debit confirmed after betting closed is refunded and the bet does not fly", async () => {
    const game = findGame((c) => c >= 200);
    const { engine, wallet, toFlight } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 1_000n);
    const pending = engine.placeBet(bet("p1", 400n)); // debit in flight...
    toFlight(); // ...betting closes before it returns
    await expectGameError(pending, "BETTING_CLOSED");
    await engine.idle();
    expect(wallet.peek("p1")).toBe(1_000n);
    expect(engine.playerBets("p1")).toEqual([]);
  });

  it("if the wallet is unreachable when betting, the stake is rolled back", async () => {
    const { engine, wallet } = await setup();
    wallet.addPlayer("p1", 1_000n);
    wallet.failNext("debit");
    await expectGameError(engine.placeBet(bet("p1", 400n)), "WALLET_UNAVAILABLE");
    await engine.idle();
    expect(wallet.peek("p1")).toBe(1_000n);
  });

  it("a win is retried until the wallet accepts it, and paid exactly once", async () => {
    const game = findGame((c) => c >= 300);
    const { engine, wallet, toFlight, advance } = await setup({ startAtGame: game });
    wallet.addPlayer("p1", 1_000n);
    await engine.placeBet(bet("p1", 1_000n, { autoCashout: 200 }));
    wallet.failNext("credit", 3);
    toFlight();
    advance(msToReach(250));
    await engine.idle();
    expect(wallet.peek("p1")).toBe(2_000n);
    expect(wallet.log.filter((l) => l.op === "credit" && !l.duplicate).length).toBe(1);
  });
});

describe("crash engine: restart recovery", () => {
  it("voids a round interrupted mid-flight, refunds open bets and still pays cash-outs", async () => {
    const game = findGame((c) => c >= 500);
    const store = new MemoryCrashStore();
    const wallet = new MemoryWallet();
    wallet.addPlayer("winner", 1_000n);
    wallet.addPlayer("open", 1_000n);

    const first = await setup({ startAtGame: game, store, wallet });
    await first.engine.placeBet(bet("winner", 1_000n));
    await first.engine.placeBet(bet("open", 1_000n));
    first.toFlight();
    first.advance(msToReach(200));
    wallet.failNext("credit", 1_000); // the win can't be delivered before the "crash"
    first.engine.cashout("winner", 0);
    await new Promise((r) => setTimeout(r, 20));
    await (first.engine as unknown as { writes: Promise<void> }).writes;
    // --- server dies here; nothing else runs ---
    (first.engine as unknown as { settlement: { stop(): void } }).settlement.stop();
    wallet.failNext("credit", 0);

    const second = await setup({ store, wallet });
    await second.engine.idle();
    const old = [...store.rounds.values()].find((r) => r.number === game)!;
    expect(old.status).toBe("VOID");
    expect(wallet.peek("open")).toBe(1_000n); // refunded
    expect(wallet.peek("winner")).toBe(2_000n); // 1000 at 2.00x, paid after restart
    expect(second.engine.snapshot().round?.number).toBe(game + 1);
    expect(await store.unsettledBets()).toEqual([]);
  });
});
