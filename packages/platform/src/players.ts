/**
 * Player registration, as in the bot flow:
 *   /start -> "Share phone number" -> we store the Telegram profile + phone.
 */
import type { Db, Player } from "@kokeb/db";

export interface TelegramProfile {
  telegramId: bigint;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
  language?: string | null;
  /** From the shared contact, digits only with country code, e.g. "251911223344". */
  phone?: string | null;
}

/** Normalize an Ethiopian phone number to 2519XXXXXXXX / 2517XXXXXXXX form. */
export function normalizeEthiopianPhone(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  let local: string;
  if (digits.startsWith("251")) local = digits.slice(3);
  else if (digits.startsWith("0")) local = digits.slice(1);
  else local = digits;
  return /^[79]\d{8}$/.test(local) ? `251${local}` : null;
}

/**
 * Create the player on first contact, or refresh their Telegram details.
 * Safe to call on every /start and every Mini App login.
 */
export async function upsertPlayer(db: Db, profile: TelegramProfile): Promise<Player> {
  const phone = profile.phone ? normalizeEthiopianPhone(profile.phone) : undefined;
  const details = {
    firstName: profile.firstName,
    lastName: profile.lastName ?? null,
    username: profile.username ?? null,
    language: profile.language ?? null,
    ...(phone ? { phone } : {}),
  };
  return db.player.upsert({
    where: { telegramId: profile.telegramId },
    create: { telegramId: profile.telegramId, ...details },
    update: details,
  });
}
