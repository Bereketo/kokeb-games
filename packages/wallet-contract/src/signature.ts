import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing for the HTTP version of the wallet API.
 *
 * signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 *
 * Sent as headers:
 *   X-Kokeb-Provider:  provider id (who is calling)
 *   X-Kokeb-Timestamp: unix seconds
 *   X-Kokeb-Signature: the hex signature
 *
 * Always sign/verify the EXACT raw body bytes, never a re-serialized object.
 * The timestamp stops an old captured request from being replayed later.
 */

export const SIGNATURE_HEADERS = {
  provider: "x-kokeb-provider",
  timestamp: "x-kokeb-timestamp",
  signature: "x-kokeb-signature",
} as const;

/** Requests older/newer than this (seconds) are rejected. */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export function signBody(secret: string, rawBody: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export interface VerifyOptions {
  secret: string;
  rawBody: string;
  timestamp: string | number | undefined;
  signature: string | undefined;
  nowSeconds?: number;
  toleranceSeconds?: number;
}

export function verifySignature(opts: VerifyOptions): boolean {
  const { secret, rawBody, signature } = opts;
  if (!signature || opts.timestamp === undefined) return false;

  const ts = typeof opts.timestamp === "number" ? opts.timestamp : Number(opts.timestamp);
  if (!Number.isInteger(ts)) return false;

  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = opts.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - ts) > tolerance) return false;

  const expected = Buffer.from(signBody(secret, rawBody, ts), "hex");
  let given: Buffer;
  try {
    given = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
