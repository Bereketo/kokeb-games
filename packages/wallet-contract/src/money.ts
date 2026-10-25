/**
 * Money helpers. Amounts are bigint minor units (santim). 1 ETB = 100 santim.
 * Converting to/from display strings is the ONLY place decimals appear.
 */

export const MINOR_UNITS_PER_MAJOR = 100n;

/** "12.5" or "12.50" or "12" -> 1250n. Throws on more than 2 decimals or junk. */
export function parseMajor(input: string): bigint {
  const s = input.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`Invalid money amount: "${input}"`);
  const [, sign, whole, frac = ""] = m;
  const value = BigInt(whole!) * MINOR_UNITS_PER_MAJOR + BigInt(frac.padEnd(2, "0"));
  return sign ? -value : value;
}

/** 1250n -> "12.50" */
export function formatMinor(amount: bigint): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / MINOR_UNITS_PER_MAJOR;
  const frac = (abs % MINOR_UNITS_PER_MAJOR).toString().padStart(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
