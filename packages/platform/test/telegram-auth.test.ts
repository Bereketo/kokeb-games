import { randomInt } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { loginWithTelegram } from "../src/auth.ts";
import { signSession, verifySession } from "../src/session-tokens.ts";
import { signInitDataForTesting, TelegramAuthError, validateInitData } from "../src/telegram-auth.ts";
import { testDb } from "./helpers.ts";

const BOT = "123456:TEST-bot-token";
const user = { id: 987654321, first_name: "Abebe", username: "abebe_k", language_code: "am" };

describe("Telegram initData validation", () => {
  it("accepts data signed for our bot and reads the user", () => {
    const v = validateInitData(signInitDataForTesting(BOT, { user, start_param: "ref42" }), BOT);
    expect(v.user.id).toBe(987654321n);
    expect(v.user.firstName).toBe("Abebe");
    expect(v.user.username).toBe("abebe_k");
    expect(v.startParam).toBe("ref42");
  });

  it("keeps huge user ids exact", () => {
    // 2^53 + 1 can't be represented as a JS number; pass Telegram's raw JSON text through.
    const raw = signInitDataForTesting(BOT, { user: '{"id":9007199254740993,"first_name":"Big"}' as never });
    expect(validateInitData(raw, BOT).user.id).toBe(9007199254740993n);
  });

  it("rejects data signed for another bot", () => {
    expect(() => validateInitData(signInitDataForTesting("999:other-bot", { user }), BOT)).toThrow(TelegramAuthError);
  });

  it("rejects tampering: changing the user id invalidates the signature", () => {
    const raw = signInitDataForTesting(BOT, { user });
    const forged = raw.replace(encodeURIComponent('"id":987654321'), encodeURIComponent('"id":111111111'));
    expect(forged).not.toBe(raw);
    expect(() => validateInitData(forged, BOT)).toThrow(/invalid signature/);
  });

  it("rejects stale data, a missing hash, and garbage", () => {
    const old = signInitDataForTesting(BOT, { user, auth_date: Math.floor(Date.now() / 1000) - 2 * 86_400 });
    expect(() => validateInitData(old, BOT)).toThrow(/expired/);
    expect(() => validateInitData("user=%7B%7D&auth_date=1", BOT)).toThrow(/hash/);
    expect(() => validateInitData("", BOT)).toThrow();
  });

  it("includes the newer `signature` field in the check (only `hash` is excluded)", () => {
    const raw = signInitDataForTesting(BOT, { user, signature: "abc123" });
    expect(validateInitData(raw, BOT).user.id).toBe(987654321n);
    const stripped = new URLSearchParams(raw);
    stripped.delete("signature");
    expect(() => validateInitData(stripped.toString(), BOT)).toThrow(/invalid signature/);
  });
});

describe("session tokens", () => {
  it("round-trips and rejects tampering or expiry", () => {
    const t = signSession("s3cret", { playerId: "p1", label: "A***e", currency: "ETB", exp: Date.now() + 1000 });
    expect(verifySession("s3cret", t)?.playerId).toBe("p1");
    expect(verifySession("other", t)).toBeNull();
    const [payload, sig] = t.split(".");
    const evil = Buffer.from(JSON.stringify({ playerId: "victim", label: "x", currency: "ETB", exp: Date.now() + 1e6 })).toString("base64url");
    expect(verifySession("s3cret", `${evil}.${sig}`)).toBeNull();
    expect(verifySession("s3cret", `${payload}.${sig}`, Date.now() + 5000)).toBeNull();
  });
});

describe("loginWithTelegram", () => {
  const db = testDb();
  afterAll(() => db.$disconnect());

  it("creates the player on first open and only grants real money once a phone is shared", async () => {
    const id = randomInt(1, 2 ** 40);
    const raw = signInitDataForTesting(BOT, { user: { id, first_name: "Selam", username: `selam${id}` } });
    const first = await loginWithTelegram(db, raw, { botToken: BOT, sessionSecret: "sess" });
    expect(first.hasPhone).toBe(false);
    expect(first.tokens.ETB).toBeNull();
    expect(verifySession("sess", first.tokens.DEMO)?.currency).toBe("DEMO");

    await db.player.update({ where: { id: first.playerId }, data: { phone: `2519${String(id).padStart(8, "0").slice(-8)}` } });
    const again = await loginWithTelegram(db, raw, { botToken: BOT, sessionSecret: "sess" });
    expect(again.playerId).toBe(first.playerId);
    expect(again.hasPhone).toBe(true);
    expect(verifySession("sess", again.tokens.ETB!)?.currency).toBe("ETB");
  });
});
