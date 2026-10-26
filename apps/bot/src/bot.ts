/**
 * The Kokeb Telegram bot.
 *
 *   /start  -> registers the player from their Telegram profile and asks them
 *              to share their phone number (one tap, verified by Telegram)
 *   contact -> saves the phone (needed for real money and Telebirr payouts)
 *              and shows the Play button that opens the Mini App
 *   /play   -> the Play button again
 *   /balance, /help
 *
 * Works in private chats only. All the logic lives here so it can be tested
 * against a simulated Telegram (see test/bot.test.ts); main.ts just runs it.
 */
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Db } from "@kokeb/db";
import { normalizeEthiopianPhone, upsertPlayer, type Ledger } from "@kokeb/platform";
import { formatMinor } from "@kokeb/wallet-contract";

export interface BotDeps {
  token: string;
  db: Db;
  ledger: Ledger;
  /** HTTPS address of the Mini App (Telegram refuses plain http). */
  miniAppUrl: string;
  brand?: string;
  /** Pass in tests to skip the getMe call. */
  botInfo?: UserFromGetMe;
  log?: (msg: string, err?: unknown) => void;
}

export const COMMANDS = [
  { command: "play", description: "Open the games" },
  { command: "balance", description: "Show your balance" },
  { command: "help", description: "How it works" },
];

export function createBot(deps: BotDeps): Bot {
  const brand = deps.brand ?? "Kokeb Games";
  const log = deps.log ?? ((msg, err) => console.error(`[bot] ${msg}`, err ?? ""));
  const bot = new Bot(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : {});
  const pm = bot.chatType("private");

  const phoneKeyboard = new Keyboard().requestContact("📱 Share my phone number").resized().oneTime();
  const canOpenMiniApp = deps.miniAppUrl.startsWith("https://");

  async function sendPlay(ctx: Context, text: string) {
    if (!canOpenMiniApp) {
      // Telegram only opens Mini Apps over HTTPS; say so instead of failing silently.
      return ctx.reply(`${text}\n\n(Setup needed: MINI_APP_URL must be an https:// address.)`);
    }
    return ctx.reply(text, { reply_markup: new InlineKeyboard().webApp("🎮 Play", deps.miniAppUrl) });
  }

  async function registerFrom(ctx: Context) {
    const from = ctx.from!;
    return upsertPlayer(deps.db, {
      telegramId: BigInt(from.id),
      firstName: from.first_name,
      lastName: from.last_name ?? null,
      username: from.username ?? null,
      language: from.language_code ?? null,
    });
  }

  pm.command("start", async (ctx) => {
    const player = await registerFrom(ctx);
    if (player.phone) {
      return sendPlay(ctx, `Welcome back, ${ctx.from.first_name}! Tap Play to open ${brand}.`);
    }
    return ctx.reply(
      `Welcome to ${brand}, ${ctx.from.first_name}! ⭐\n\n` +
        "To get started, share your phone number with the button below. " +
        "We use it to secure your account and for deposits and withdrawals.\n\n" +
        "You can try the games in demo mode right away with /play.",
      { reply_markup: phoneKeyboard },
    );
  });

  pm.on("message:contact", async (ctx) => {
    const contact = ctx.message.contact;
    // Only accept the user's OWN number (Telegram fills user_id for the sender's own contact).
    if (contact.user_id !== ctx.from.id) {
      return ctx.reply("Please share your own number using the button below.", { reply_markup: phoneKeyboard });
    }
    const phone = normalizeEthiopianPhone(contact.phone_number);
    if (!phone) {
      return ctx.reply(
        `${brand} currently supports Ethiopian mobile numbers (+251 9… or +251 7…). ` +
          "You can still play in demo mode with /play.",
        { reply_markup: { remove_keyboard: true } },
      );
    }
    const owner = await deps.db.player.findUnique({ where: { phone }, select: { telegramId: true } });
    if (owner && owner.telegramId !== BigInt(ctx.from.id)) {
      return ctx.reply("This number is already linked to another Telegram account. Contact support if this is yours.", {
        reply_markup: { remove_keyboard: true },
      });
    }
    await upsertPlayer(deps.db, {
      telegramId: BigInt(ctx.from.id),
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name ?? null,
      username: ctx.from.username ?? null,
      language: ctx.from.language_code ?? null,
      phone,
    });
    await ctx.reply(`✅ Phone verified: +${phone.slice(0, 3)} ${phone.slice(3, 5)} *** ${phone.slice(-4)}`, {
      reply_markup: { remove_keyboard: true },
    });
    return sendPlay(ctx, "You're all set. Tap Play to start.");
  });

  pm.command("play", async (ctx) => {
    await registerFrom(ctx);
    return sendPlay(ctx, `Tap Play to open ${brand}.`);
  });

  pm.command("balance", async (ctx) => {
    const player = await registerFrom(ctx);
    const [etb, demo] = await Promise.all([deps.ledger.balance(player.id, "ETB"), deps.ledger.balance(player.id, "DEMO")]);
    const lines = [`💰 Balance: ${formatMinor(etb)} ETB`, `🎮 Demo: ${formatMinor(demo)}`];
    if (!player.phone) lines.push("", "Share your phone number with /start to play with real money.");
    return ctx.reply(lines.join("\n"));
  });

  pm.command("help", (ctx) =>
    ctx.reply(
      `${brand} — how it works\n\n` +
        "1. Share your phone number (/start)\n" +
        "2. Tap Play to open the games\n" +
        "3. Try Demo for free, or deposit to play with ETB\n\n" +
        "Every round is provably fair: open Fairness in the game to check results yourself.\n\n" +
        "Commands: /play /balance /help",
    ),
  );

  // Anything else in private chat: point them to the right place.
  pm.on("message", async (ctx) => {
    const player = await registerFrom(ctx);
    if (!player.phone) return ctx.reply("Share your phone number to get started.", { reply_markup: phoneKeyboard });
    return sendPlay(ctx, "Tap Play to open the games, or see /help.");
  });

  bot.catch((err) => log(`error handling update ${err.ctx.update.update_id}`, err.error));
  return bot;
}
