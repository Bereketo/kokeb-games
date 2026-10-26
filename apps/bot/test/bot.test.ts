/**
 * Bot conversations against a simulated Telegram: updates go in, and every
 * API call the bot makes is captured instead of sent.
 */
import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Bot } from "grammy";
import { createDb } from "@kokeb/db";
import { Ledger } from "@kokeb/platform";
import { createBot } from "../src/bot.ts";

const rootEnv = new URL("../../../.env", import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const db = createDb();
const ledger = new Ledger(db, { timeoutMs: 60_000 });
afterAll(() => db.$disconnect());

type Call = { method: string; payload: any };

function makeBot(miniAppUrl = "https://play.example.com") {
  const bot = createBot({
    token: "123456:TEST",
    db,
    ledger,
    miniAppUrl,
    botInfo: {
      id: 123456, is_bot: true, first_name: "Kokeb", username: "kokeb_test_bot",
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: false,
    } as never,
    log: (msg, err) => { throw err ?? new Error(msg); },
  });
  const calls: Call[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 1, type: "private" } } } as never;
  });
  return { bot, calls };
}

let updateId = 1;
function user(id: number) {
  return { id, is_bot: false, first_name: "Abebe", username: `abebe${id}`, language_code: "am" };
}
function text(from: ReturnType<typeof user>, body: string) {
  const isCmd = body.startsWith("/");
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private" as const, first_name: from.first_name },
      from, text: body,
      ...(isCmd ? { entities: [{ type: "bot_command" as const, offset: 0, length: body.split(" ")[0]!.length }] } : {}),
    },
  };
}
function contact(from: ReturnType<typeof user>, phone: string, ownerId: number | undefined) {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: from.id, type: "private" as const, first_name: from.first_name },
      from, contact: { phone_number: phone, first_name: from.first_name, ...(ownerId !== undefined ? { user_id: ownerId } : {}) },
    },
  };
}
const send = (bot: Bot, update: object) => bot.handleUpdate(update as never);
const last = (calls: Call[]) => calls[calls.length - 1]!.payload;
const phoneFor = (id: number) => `+2519${String(id).padStart(8, "0").slice(-8)}`;

describe("bot", () => {
  let id: number;
  beforeEach(() => { id = randomInt(100_000_000, 999_999_999); });

  it("/start registers the player and asks for their phone", async () => {
    const { bot, calls } = makeBot();
    await send(bot, text(user(id), "/start"));
    expect(last(calls).text).toMatch(/share your phone number/i);
    expect(last(calls).reply_markup.keyboard[0][0].request_contact).toBe(true);
    const p = await db.player.findUnique({ where: { telegramId: BigInt(id) } });
    expect(p?.firstName).toBe("Abebe");
    expect(p?.phone).toBeNull();
  });

  it("sharing your own Ethiopian number verifies it and shows the Play button", async () => {
    const { bot, calls } = makeBot();
    const u = user(id);
    await send(bot, text(u, "/start"));
    await send(bot, contact(u, phoneFor(id), id));
    const texts = calls.map((c) => c.payload.text);
    expect(texts.some((t) => /Phone verified/.test(t))).toBe(true);
    const play = last(calls);
    expect(play.reply_markup.inline_keyboard[0][0].web_app.url).toBe("https://play.example.com");
    const p = await db.player.findUnique({ where: { telegramId: BigInt(id) } });
    expect(p?.phone).toBe(phoneFor(id).slice(1));
    // returning players go straight to Play
    await send(bot, text(u, "/start"));
    expect(last(calls).text).toMatch(/Welcome back/);
  });

  it("refuses someone else's contact card", async () => {
    const { bot, calls } = makeBot();
    await send(bot, contact(user(id), phoneFor(id), id + 1));
    expect(last(calls).text).toMatch(/your own number/);
    await send(bot, contact(user(id), phoneFor(id), undefined)); // a card typed in by hand
    expect(last(calls).text).toMatch(/your own number/);
    expect((await db.player.findUnique({ where: { telegramId: BigInt(id) } }))?.phone ?? null).toBeNull();
  });

  it("refuses non-Ethiopian numbers", async () => {
    const { bot, calls } = makeBot();
    await send(bot, contact(user(id), "+14155550123", id));
    expect(last(calls).text).toMatch(/Ethiopian mobile numbers/);
  });

  it("won't link one phone number to two Telegram accounts", async () => {
    const { bot, calls } = makeBot();
    const phone = phoneFor(id);
    await send(bot, contact(user(id), phone, id));
    const other = id + 7;
    await send(bot, contact(user(other), phone, other));
    expect(last(calls).text).toMatch(/already linked/);
  });

  it("/balance shows real and demo balances", async () => {
    const { bot, calls } = makeBot();
    const u = user(id);
    await send(bot, contact(u, phoneFor(id), id));
    const p = await db.player.findUniqueOrThrow({ where: { telegramId: BigInt(id) } });
    await ledger.deposit({ playerId: p.id, amount: 25_050n, source: "test", reference: `bal-${id}` });
    await send(bot, text(u, "/balance"));
    expect(last(calls).text).toMatch(/250\.50 ETB/);
    expect(last(calls).text).toMatch(/Demo: 10000\.00/);
  });

  it("explains the setup problem instead of sending a broken Play button when the URL isn't https", async () => {
    const { bot, calls } = makeBot("http://localhost:4001");
    await send(bot, text(user(id), "/play"));
    expect(last(calls).text).toMatch(/must be an https/);
    expect(last(calls).reply_markup).toBeUndefined();
  });

  it("ignores group chats", async () => {
    const { bot, calls } = makeBot();
    const u = user(id);
    const groupMsg = text(u, "/start");
    (groupMsg.message.chat as any) = { id: -100123, type: "group", title: "x" };
    await send(bot, groupMsg);
    expect(calls).toEqual([]);
  });
});
