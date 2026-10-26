/**
 * Validates the `initData` a Telegram Mini App receives when it opens.
 *
 * Telegram signs it with a key derived from our bot token, so a valid
 * signature proves the user data came from Telegram for OUR bot, and nobody
 * can log in as someone else by editing it.
 *
 *   secret = HMAC-SHA256(key = "WebAppData", message = botToken)
 *   check  = all fields except `hash`, as "key=value", sorted, joined by "\n"
 *   valid  = hex(HMAC-SHA256(key = secret, message = check)) == hash
 *
 * Plus a freshness check on auth_date, so a captured initData can't be
 * replayed forever.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramWebAppUser {
  id: bigint;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
}

export interface ValidInitData {
  user: TelegramWebAppUser;
  authDate: Date;
  startParam: string | null;
}

export class TelegramAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramAuthError";
  }
}

export interface ValidateOptions {
  /** Reject initData older than this. Default 24 h. */
  maxAgeSeconds?: number;
  nowSeconds?: number;
}

export function validateInitData(raw: string, botToken: string, opts: ValidateOptions = {}): ValidInitData {
  if (!raw || typeof raw !== "string") throw new TelegramAuthError("missing initData");
  if (!botToken) throw new TelegramAuthError("bot token not configured");

  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new TelegramAuthError("missing or malformed hash");

  const pairs: string[] = [];
  for (const [key, value] of params) if (key !== "hash") pairs.push(`${key}=${value}`);
  pairs.sort();
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(pairs.join("\n")).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new TelegramAuthError("invalid signature");
  }

  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate) || authDate <= 0) throw new TelegramAuthError("missing auth_date");
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (now - authDate > (opts.maxAgeSeconds ?? 86_400)) throw new TelegramAuthError("initData expired, reopen the app");

  const userJson = params.get("user");
  if (!userJson) throw new TelegramAuthError("no user in initData");
  let u: Record<string, unknown>;
  try {
    u = JSON.parse(userJson);
  } catch {
    throw new TelegramAuthError("malformed user");
  }
  // Read the id from the raw JSON so very large ids never lose precision.
  const idMatch = /"id"\s*:\s*(\d+)/.exec(userJson);
  if (!idMatch || typeof u.first_name !== "string") throw new TelegramAuthError("malformed user");

  return {
    user: {
      id: BigInt(idMatch[1]!),
      firstName: u.first_name,
      lastName: typeof u.last_name === "string" ? u.last_name : null,
      username: typeof u.username === "string" ? u.username : null,
      languageCode: typeof u.language_code === "string" ? u.language_code : null,
    },
    authDate: new Date(authDate * 1000),
    startParam: params.get("start_param"),
  };
}

/** Builds signed initData exactly as Telegram does. For tests and local development only. */
export function signInitDataForTesting(
  botToken: string,
  fields: { user: Record<string, unknown>; auth_date?: number; [k: string]: unknown },
): string {
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) params[k] = typeof v === "string" ? v : JSON.stringify(v);
  params.auth_date ??= String(Math.floor(Date.now() / 1000));
  const check = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...params, hash }).toString();
}
