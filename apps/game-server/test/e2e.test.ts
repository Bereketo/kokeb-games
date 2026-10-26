/**
 * End to end: real HTTP + WebSocket server, real engine, real Postgres ledger.
 * Plays real-money (ETB) rounds as a browser would and checks the books.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createDb } from "@kokeb/db";
import { CrashEngine, HashChain, crashPointFromHash } from "@kokeb/games";
import { InProcessWallet, Ledger } from "@kokeb/platform";
import { PrismaCrashStore } from "../src/prisma-store.ts";
import { startServer } from "../src/server.ts";

const rootEnv = new URL("../../../.env", import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const SALT = "e2e-salt";
const PORT = 4100 + Math.floor(Math.random() * 500);
const secret = `e2e-${randomBytes(24).toString("hex")}`; // fresh chain => starts at game 1
const chain = HashChain.fromSecret(secret, 500);
const crashOf = (n: number) => crashPointFromHash(chain.hashForGame(n), SALT, 300);

const db = createDb();
const ledger = new Ledger(db, { timeoutMs: 60_000 });
const wallet = new InProcessWallet(ledger);
const engine = new CrashEngine({
  wallet,
  store: new PrismaCrashStore(db, chain.commitment),
  chain,
  config: { salt: SALT, bettingMs: 8_000, cooldownMs: 300 }, // wide window: remote DBs are slow
  log: () => {},
});
let server: ReturnType<typeof startServer>;
let loop: ReturnType<typeof setInterval>;

beforeAll(async () => {
  await engine.start();
  loop = setInterval(() => engine.step(), 20);
  server = startServer({
    engine,
    wallet,
    ledger,
    db,
    config: {
      production: false, port: PORT, displayName: "Test", chainSecret: secret, chainLength: 500, salt: SALT,
      houseEdgeBps: 300, bettingMs: 8_000, cooldownMs: 300, sessionSecret: "e2e-session", devTools: true,
    },
  });
});

afterAll(async () => {
  clearInterval(loop);
  await server.close();
  await engine.stop();
  await db.$disconnect();
});

const base = `http://localhost:${PORT}`;
const post = async (path: string, body: unknown) =>
  (await fetch(base + path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } })).json() as Promise<any>;

/** Minimal game client. */
function connect(): Promise<{ ws: WebSocket; next: (pred: (m: any) => boolean) => Promise<any>; call: (msg: object) => Promise<any> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    const inbox: any[] = [];
    const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
    let seq = 0;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const w = waiters.findIndex((x) => x.pred(m));
      if (w >= 0) waiters.splice(w, 1)[0]!.resolve(m);
      else inbox.push(m);
    });
    const next = (pred: (m: any) => boolean) =>
      new Promise<any>((res) => {
        const i = inbox.findIndex(pred);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ pred, resolve: res });
      });
    const call = (msg: object) => {
      const id = ++seq;
      ws.send(JSON.stringify({ ...msg, id }));
      return next((m) => m.type === "reply" && m.id === id);
    };
    ws.on("open", () => resolve({ ws, next, call }));
  });
}

describe("game server end to end", () => {
  it("plays real-money rounds: auto cash-out, manual cash-out and a loss, and the books balance", async () => {
    const login = await post("/dev/login", { name: `e2e-${randomBytes(4).toString("hex")}` });
    const faucet = await post("/dev/faucet", { token: login.tokens.ETB });
    expect(faucet.balance).toBe("1000.00");

    const c = await connect();
    expect((await c.call({ type: "auth", token: "garbage" })).code).toBe("UNAUTHORIZED");
    expect((await c.call({ type: "auth", token: login.tokens.ETB })).ok).toBe(true);

    let expected = 100_000n; // santim
    const played: string[] = [];

    for (let played_ = 0; played_ < 3; played_++) {
      // Play the next round that opens for betting (never one already underway).
      const betting = await c.next((m) => m.type === "round:betting");
      const n: number = betting.round.number;
      const crash = crashOf(n);

      // slot 0: auto cash-out at 1.01x
      const r0 = await c.call({ type: "bet", slot: 0, amount: "10", autoCashout: "1.01" });
      expect(r0.ok).toBe(true);
      expected -= 1_000n;
      // slot 1: manual, cash out as soon as the multiplier reaches 1.05x if it gets there
      const r1 = await c.call({ type: "bet", slot: 1, amount: "5", autoCashout: null });
      expect(r1.ok).toBe(true);
      expected -= 500n;

      const flying = await c.next((m) => m.type === "round:flying" && m.round.number === n);
      if (crash > 105) {
        await c.next((m) => m.type === "tick" && m.serverTime >= flying.serverTime && m.multiplier >= 105);
        const out = await c.call({ type: "cashout", slot: 1 });
        expect(out.ok).toBe(true);
        expect(out.bet.cashoutMultiplier).toBeGreaterThanOrEqual(105);
        expected += (500n * BigInt(out.bet.cashoutMultiplier)) / 100n;
        played.push(`game ${n}: crash ${crash}, manual cash-out at ${out.bet.cashoutMultiplier}`);
      } else {
        played.push(`game ${n}: crash ${crash}, manual bet lost`);
      }
      if (crash > 101) expected += 1_010n; // auto 1.01x won

      const crashed = await c.next((m) => m.type === "round:crashed" && m.round.number === n);
      expect(crashed.round.crashPoint).toBe(crash);
      expect(crashed.round.hash).toBe(chain.hashForGame(n));
    }

    await engine.idle();
    const playerId = (await db.player.findFirstOrThrow({ where: { username: { startsWith: "e2e-" } }, orderBy: { createdAt: "desc" } })).id;
    expect(await ledger.balance(playerId, "ETB")).toBe(expected);
    const bets = await db.crashBet.findMany({ where: { playerId } });
    expect(bets.length).toBeGreaterThanOrEqual(2);
    expect(bets.every((b) => b.settled)).toBe(true);
    expect(await ledger.verifyIntegrity()).toEqual([]);
    console.log(played.join("\n"));
    c.ws.close();
  });

  it("publishes the fairness data a player needs to verify rounds", async () => {
    const f = (await (await fetch(`${base}/api/fairness`)).json()) as any;
    expect(f.commitment).toBe(chain.commitment);
    expect(f.salt).toBe(SALT);
    expect(f.houseEdgeBps).toBe(300);
  });
});
