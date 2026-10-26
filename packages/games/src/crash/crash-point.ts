/**
 * Crash point from a game hash.
 *
 *   hmac = HMAC-SHA256(key = gameHash, message = salt)
 *   r    = first 52 bits of hmac           (uniform in [0, 2^52))
 *   X    = r / 2^52                        (uniform in [0, 1))
 *   crash = floor( 100 * (1 - edge) / (1 - X) ) / 100,  at least 1.00
 *
 * This gives P(crash >= m) = (1 - edge) / m for every m >= 1, so whatever
 * cash-out target a player picks, they get back (1 - edge) of their stake on
 * average. The house edge is the ONLY lever, and it's the same for everyone.
 *
 * `salt` is a public value fixed AFTER the chain commitment was published
 * (e.g. a future Bitcoin block hash), so we couldn't have picked a chain that
 * favours the house.
 *
 * Multipliers are integers in hundredths: 1.00x = 100, 2.35x = 235.
 */
import { createHmac } from "node:crypto";

const TWO_POW_52 = 2n ** 52n;

export function crashPointFromHash(gameHash: string, salt: string, houseEdgeBps: number): number {
  if (!Number.isInteger(houseEdgeBps) || houseEdgeBps < 0 || houseEdgeBps >= 10_000) {
    throw new Error("houseEdgeBps must be an integer in [0, 10000)");
  }
  const hmac = createHmac("sha256", Buffer.from(gameHash, "hex")).update(salt).digest("hex");
  const r = BigInt(`0x${hmac.slice(0, 13)}`); // 13 hex chars = 52 bits
  // crash*100 = (10000 - bps) * 2^52 / (100 * (2^52 - r))
  const hundredths = (BigInt(10_000 - houseEdgeBps) * TWO_POW_52) / (100n * (TWO_POW_52 - r));
  return Math.max(100, Number(hundredths));
}

/** "2.35x" style formatting of a hundredths multiplier. */
export function formatMultiplier(hundredths: number): string {
  return `${(hundredths / 100).toFixed(2)}x`;
}
