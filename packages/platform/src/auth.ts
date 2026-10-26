/**
 * Mini App login: Telegram initData in, game session tokens out.
 */
import type { Db } from "@kokeb/db";
import { upsertPlayer } from "./players.ts";
import { maskLabel, signSession } from "./session-tokens.ts";
import { validateInitData, type ValidateOptions } from "./telegram-auth.ts";

export interface TelegramLoginResult {
  playerId: string;
  label: string;
  firstName: string;
  /** Real money needs a verified phone (shared in the bot). */
  hasPhone: boolean;
  tokens: { DEMO: string; ETB: string | null };
}

export interface TelegramLoginOptions extends ValidateOptions {
  botToken: string;
  sessionSecret: string;
  /** Session lifetime. Default 12 h. */
  ttlMs?: number;
}

export async function loginWithTelegram(db: Db, initData: string, opts: TelegramLoginOptions): Promise<TelegramLoginResult> {
  const { user } = validateInitData(initData, opts.botToken, opts);
  const player = await upsertPlayer(db, {
    telegramId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    language: user.languageCode,
  });
  const label = maskLabel(user.username ?? user.firstName);
  const exp = Date.now() + (opts.ttlMs ?? 12 * 60 * 60 * 1000);
  const hasPhone = Boolean(player.phone);
  return {
    playerId: player.id,
    label,
    firstName: player.firstName,
    hasPhone,
    tokens: {
      DEMO: signSession(opts.sessionSecret, { playerId: player.id, label, currency: "DEMO", exp }),
      ETB: hasPhone ? signSession(opts.sessionSecret, { playerId: player.id, label, currency: "ETB", exp }) : null,
    },
  };
}
