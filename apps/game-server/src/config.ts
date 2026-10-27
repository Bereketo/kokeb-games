import { existsSync } from "node:fs";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const env = process.env;
const production = env.NODE_ENV === "production";

function required(name: string, devDefault: string): string {
  const v = env[name];
  if (v) return v;
  if (production) throw new Error(`${name} must be set in production`);
  console.warn(`[config] ${name} not set, using an insecure development value`);
  return devDefault;
}

function int(name: string, fallback: number): number {
  const v = env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer`);
  return n;
}

export const config = {
  production,
  port: int("GAME_SERVER_PORT", 4001),
  /** Name shown to players. */
  displayName: env.GAME_DISPLAY_NAME || "Crash",
  /** Secret that generates the provably-fair hash chain. NEVER change or leak it while the chain is in use. */
  chainSecret: required("CRASH_CHAIN_SECRET", "development-only-chain-secret-do-not-use-in-production"),
  chainLength: int("CRASH_CHAIN_LENGTH", 1_000_000),
  /** Public salt, fixed AFTER the chain commitment is published (e.g. a future Bitcoin block hash). */
  salt: required("CRASH_SALT", "development-salt"),
  houseEdgeBps: int("CRASH_HOUSE_EDGE_BPS", 300),
  bettingMs: int("CRASH_BETTING_MS", 6_000),
  cooldownMs: int("CRASH_COOLDOWN_MS", 3_000),
  /** Name players see for bingo. */
  bingoDisplayName: env.BINGO_DISPLAY_NAME || "75-Ball Bingo",
  /** Public seed that fixes every cartela's numbers. Never change it once players know their cards. */
  bingoDeckSeed: env.BINGO_DECK_SEED || "kokeb-bingo-deck-v1",
  /** House cut of each bingo pot in basis points (2000 = 20%). */
  bingoCommissionBps: int("BINGO_COMMISSION_BPS", 2_000),
  bingoCountdownMs: int("BINGO_COUNTDOWN_MS", 30_000),
  bingoDrawIntervalMs: int("BINGO_DRAW_INTERVAL_MS", 3_000),
  /** Signs player session tokens. */
  sessionSecret: required("SESSION_SECRET", "development-session-secret"),
  /** Bot token from @BotFather; needed to verify Mini App logins. */
  telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
  /** Dev-only endpoints: instant login and a free-ETB faucet. Never in production. */
  devTools: !production && env.DEV_TOOLS !== "false",
};
