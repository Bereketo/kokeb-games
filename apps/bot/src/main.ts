/**
 * Runs the bot with long polling (no public URL needed).
 * Run ONE instance per bot token: Telegram allows a single poller.
 */
import { existsSync } from "node:fs";
import { createDb } from "@kokeb/db";
import { Ledger } from "@kokeb/platform";
import { COMMANDS, createBot } from "./bot.ts";

const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("[bot] TELEGRAM_BOT_TOKEN is not set. Create a bot with @BotFather and put its token in .env");
  process.exit(1);
}
const miniAppUrl = process.env.MINI_APP_URL ?? "";
if (!miniAppUrl.startsWith("https://")) {
  console.warn("[bot] MINI_APP_URL is not an https:// address; the Play button won't open the game until it is.");
}

const db = createDb();
const bot = createBot({ token, db, ledger: new Ledger(db), miniAppUrl, brand: process.env.BRAND_NAME || "Kokeb Games" });

await bot.api.setMyCommands(COMMANDS);
if (miniAppUrl.startsWith("https://")) {
  // The menu button next to the message box opens the Mini App directly.
  await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Play", web_app: { url: miniAppUrl } } });
}

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[bot] ${signal}: stopping`);
  await bot.stop();
  await db.$disconnect();
  process.exit(0);
}
process.once("SIGINT", () => void stop("SIGINT"));
process.once("SIGTERM", () => void stop("SIGTERM"));

await bot.start({
  drop_pending_updates: false,
  onStart: (me) => console.log(`[bot] @${me.username} is running (long polling)`),
});
