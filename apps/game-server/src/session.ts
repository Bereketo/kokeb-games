/**
 * Player session tokens for the game connection.
 *
 * token = base64url(json payload) + "." + base64url(HMAC-SHA256(secret, payload))
 *
 * Today the dev login issues them; with the Mini App (roadmap step 3) the
 * platform issues them after validating Telegram initData.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Currency } from "@kokeb/wallet-contract";

export interface Session {
  playerId: string;
  label: string;
  currency: Currency;
  /** Unix ms. */
  exp: number;
}

export function signSession(secret: string, s: Session): string {
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifySession(secret: string, token: unknown, now = Date.now()): Session | null {
  if (typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (typeof s.exp !== "number" || s.exp < now) return null;
    if (s.currency !== "ETB" && s.currency !== "DEMO") return null;
    return s;
  } catch {
    return null;
  }
}

/** "Abebe" -> "A***e", "251911223344" -> "25***44" */
export function maskLabel(name: string): string {
  const s = name.trim();
  if (s.length <= 2) return `${s[0] ?? "?"}***`;
  const keep = s.length >= 8 ? 2 : 1;
  return `${s.slice(0, keep)}***${s.slice(-keep)}`;
}
