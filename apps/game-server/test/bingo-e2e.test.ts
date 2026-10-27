/**
 * Bingo end to end: real server, WebSocket clients, Postgres ledger, ETB money.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createDb } from "@kokeb/db";
import { BingoEngine, CrashEngine, HashChain, drawOrder, winningPattern } from "@kokeb/games";
import { InProcessWallet, Ledger } from "@kokeb/platform";
import { PrismaBingoStore } from "../src/bingo-store.ts";
import { PrismaCrashStore } from "../src/prisma-store.ts";
import { startServer } from "../src/server.ts";

const rootEnv = new URL("../../../.env", import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PORT = 4600 + Math.floor(Math.random() * 300);
const db = createDb();
const ledger = new Ledger(db, { timeoutMs: 60_000 });
const wallet = new InProcessWallet(ledger);
const chain = HashChain.fromSecret(`bingo-e2e-${randomBytes(16).toString("hex")}`, 50);
const crash = new CrashEngine({ wallet, store: new PrismaCrashStore(db, chain.commitment), chain, config: { salt: "x" }, log: () => {} });
const bingo = new BingoEngine({
  wallet,
  store: new PrismaBingoStore(db),
  // Only one room so this test doesn't share games with anything else; a wide countdown tolerates slow remote DBs.
  config: {
    deckSeed: "e2e-deck",
    rooms: [{ id: `e2e-${randomBytes(3).toString("hex")}`, name: "Test", currency: "ETB", stake: 1_000n }],
    countdownMs: 8_000,
    drawIntervalMs: 300,
    claimWindowMs: 800,
    resultsMs: 60_000,
  },
  log: () => {},
});
const ROOM = bingo.config.rooms[0]!.id;
let server: ReturnType<typeof startServer>;
let loop: ReturnType<typeof setInterval>;

beforeAll(async () => {
  await crash.start();
  await bingo.start();
  loop = setInterval(() => {
    crash.step();
    bingo.step();
  }, 20);
  server = startServer({
    engine: crash,
    bingo,
    wallet,
    ledger,
    db,
    config: {
      production: false, port: PORT, displayName: "Crash", chainSecret: "x".repeat(32), chainLength: 50, salt: "x",
      houseEdgeBps: 300, bettingMs: 6_000, cooldownMs: 3_000, sessionSecret: "bingo-e2e", devTools: true, telegramBotToken: "",
      bingoDisplayName: "75-Ball Bingo", bingoDeckSeed: "e2e-deck", bingoCommissionBps: 2_000, bingoCountdownMs: 8_000, bingoDrawIntervalMs: 300,
    },
  });
});

afterAll(async () => {
  clearInterval(loop);
  await server.close();
  await crash.stop();
  await bingo.stop();
  await db.$disconnect();
});

const base = `http://localhost:${PORT}`;
const post = async (path: string, body: unknown) => (await fetch(base + path, { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;

function connect(): Promise<{ ws: WebSocket; next: (p: (m: any) => boolean) => Promise<any>; call: (m: object) => Promise<any>; seen: any[] }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/bingo`);
    const inbox: any[] = [];
    const seen: any[] = [];
    const waiters: { p: (m: any) => boolean; r: (m: any) => void }[] = [];
    let seq = 0;
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      seen.push(m);
      const i = waiters.findIndex((w) => w.p(m));
      if (i >= 0) waiters.splice(i, 1)[0]!.r(m);
      else inbox.push(m);
    });
    const next = (p: (m: any) => boolean) =>
      new Promise<any>((r) => {
        const i = inbox.findIndex(p);
        if (i >= 0) return r(inbox.splice(i, 1)[0]);
        waiters.push({ p, r });
      });
    const call = (m: object) => {
      const id = ++seq;
      ws.send(JSON.stringify({ ...m, id }));
      return next((x) => x.type === "reply" && x.id === id);
    };
    ws.on("open", () => resolve({ ws, next, call, seen }));
  });
}

describe("bingo end to end", () => {
  it("two players buy cartelas with ETB, the draw runs, BINGO is claimed, and the money adds up", async () => {
    const cfg = (await (await fetch(`${base}/api/bingo/config`)).json()) as any;
    expect(cfg.deck.length).toBe(100);

    const players = await Promise.all(
      ["a", "b"].map(async (n) => {
        const login = await post("/dev/login", { name: `bingo-${n}-${randomBytes(3).toString("hex")}` });
        await post("/dev/faucet", { token: login.tokens.ETB }); // 1,000 ETB
        const c = await connect();
        expect((await c.call({ type: "auth", token: login.tokens.ETB })).ok).toBe(true);
        return { login, c };
      }),
    );
    const [A, B] = players as [(typeof players)[0], (typeof players)[0]];

    // wrong mode is refused: a DEMO session can't buy in an ETB room
    const demo = await connect();
    await demo.call({ type: "auth", token: A.login.tokens.DEMO });
    expect((await demo.call({ type: "pick", roomId: ROOM, card: 5 })).code).toBe("WRONG_MODE");
    demo.ws.close();

    expect((await A.c.call({ type: "pick", roomId: ROOM, card: 11 })).ok).toBe(true);
    expect((await B.c.call({ type: "pick", roomId: ROOM, card: 11 })).code).toBe("CARD_TAKEN");
    expect((await B.c.call({ type: "pick", roomId: ROOM, card: 64 })).ok).toBe(true);

    // A taps BINGO as soon as cartela 11 wins; B never claims (auto-claim may still win it for B)
    const deck = cfg.deck as number[][];
    let room: any;
    for (;;) {
      const m = await A.c.next((x) => (x.type === "bingo:room" && x.room.roomId === ROOM) || (x.type === "bingo:ball" && x.roomId === ROOM));
      if (m.type === "bingo:room") {
        room = m.room;
        if (room.status === "FINISHED") break;
        continue;
      }
      const called = new Set<number>(A.c.seen.filter((x) => x.type === "bingo:ball" && x.roomId === ROOM).map((x) => x.ball));
      if (winningPattern(deck[10]!, called)) await A.c.call({ type: "claim", roomId: ROOM, card: 11 });
    }

    // the revealed seed matches the fingerprint shown before the game, and produced the calls
    expect(createHash("sha256").update(room.seed).digest("hex")).toBe(room.seedHash);
    expect(room.called).toEqual(drawOrder(room.seed).slice(0, room.called.length));
    expect(room.winners.length).toBeGreaterThanOrEqual(1);
    expect(room.winners.reduce((s: bigint, w: any) => s + BigInt(w.payout), 0n)).toBe(1_600n); // 2 × 10 ETB − 20%

    await bingo.idle();
    const cards = await db.bingoCard.findMany({ where: { gameId: room.gameId } });
    expect(cards.length).toBe(2);
    expect(cards.every((c) => c.settled)).toBe(true);
    const balances = await Promise.all(cards.map((c) => ledger.balance(c.playerId, "ETB")));
    expect(balances.reduce((s, b) => s + b, 0n)).toBe(200_000n - 400n); // only the 4 ETB cut left the players
    expect(await ledger.verifyIntegrity()).toEqual([]);
    A.c.ws.close();
    B.c.ws.close();
  });
});
