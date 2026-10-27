/**
 * Game server entry point: wires the crash engine to the in-process wallet
 * and the Postgres store, runs exactly ONE round loop, and serves players.
 *
 * Run a single instance. Two instances would run two round loops.
 */
import { createDb } from "@kokeb/db";
import { BingoEngine, CrashEngine, HashChain } from "@kokeb/games";
import { InProcessWallet, Ledger } from "@kokeb/platform";
import { config } from "./config.ts";
import { PrismaBingoStore } from "./bingo-store.ts";
import { PrismaCrashStore } from "./prisma-store.ts";
import { startServer } from "./server.ts";

const db = createDb();
const ledger = new Ledger(db);
const wallet = new InProcessWallet(ledger);

const t0 = Date.now();
const chain = HashChain.fromSecret(config.chainSecret, config.chainLength);
console.log(`[game-server] hash chain ready (${config.chainLength.toLocaleString()} games, ${Date.now() - t0} ms)`);
console.log(`[game-server] chain commitment: ${chain.commitment}`);

const engine = new CrashEngine({
  wallet,
  store: new PrismaCrashStore(db, chain.commitment),
  chain,
  config: {
    gameId: "crash",
    salt: config.salt,
    houseEdgeBps: config.houseEdgeBps,
    bettingMs: config.bettingMs,
    cooldownMs: config.cooldownMs,
  },
});

const bingo = new BingoEngine({
  wallet,
  store: new PrismaBingoStore(db),
  config: {
    deckSeed: config.bingoDeckSeed,
    commissionBps: config.bingoCommissionBps,
    countdownMs: config.bingoCountdownMs,
    drawIntervalMs: config.bingoDrawIntervalMs,
  },
});

await engine.start();
await bingo.start();
// One loop drives both games. Run a single instance of this server.
const loop = setInterval(() => {
  engine.step();
  bingo.step();
}, 50);
const server = startServer({ engine, bingo, wallet, ledger, db, config });
if (config.devTools) console.log("[game-server] dev tools ON: open the page and log in with any name");

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[game-server] ${signal}: finishing settlements and shutting down`);
  // Backstop: never hang a deploy. Anything unfinished is resumed on next start.
  setTimeout(() => {
    console.error("[game-server] shutdown took too long, exiting anyway");
    process.exit(1);
  }, 15_000).unref();
  clearInterval(loop);
  await server.close();
  await engine.stop();
  await bingo.stop();
  await db.$disconnect();
  console.log("[game-server] stopped cleanly");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
