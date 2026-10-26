/**
 * How the multiplier grows while the round is flying:
 *   m(t) = e^(GROWTH * t_ms), floored to hundredths.
 * 2x after ~11.6 s, 10x after ~38 s, 100x after ~77 s.
 *
 * The server and every client use this same curve, so clients can animate
 * smoothly from the round's start time and the server only sends syncs.
 */
export const GROWTH_PER_MS = 0.00006;

/** Multiplier (hundredths) after `elapsedMs` of flight. */
export function multiplierAt(elapsedMs: number): number {
  if (elapsedMs <= 0) return 100;
  return Math.floor(100 * Math.exp(GROWTH_PER_MS * elapsedMs));
}

/** First elapsed ms at which the multiplier reaches `hundredths`. */
export function msToReach(hundredths: number): number {
  if (hundredths <= 100) return 0;
  let ms = Math.ceil(Math.log(hundredths / 100) / GROWTH_PER_MS);
  // Float rounding: make sure multiplierAt(ms) >= target, and ms-1 is below it.
  while (multiplierAt(ms) < hundredths) ms++;
  while (ms > 0 && multiplierAt(ms - 1) >= hundredths) ms--;
  return ms;
}
