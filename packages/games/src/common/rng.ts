/**
 * Deterministic, verifiable randomness from a seed.
 *
 *   value #k = first 4 bytes (big-endian) of HMAC-SHA256(key = seed, message = `${label}:${k}`)
 *
 * Integers in a range use rejection sampling (no modulo bias). Anyone with the
 * seed can rerun exactly the same sequence; the game pages do it in the
 * browser to verify results.
 */
import { createHmac } from "node:crypto";

export class SeededRng {
  private readonly key: string;
  private readonly label: string;
  private counter = 0;

  constructor(key: string, label: string) {
    this.key = key;
    this.label = label;
  }

  nextUint32(): number {
    const h = createHmac("sha256", this.key).update(`${this.label}:${this.counter++}`).digest();
    return h.readUInt32BE(0);
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new Error("bad range");
    const limit = Math.floor(2 ** 32 / n) * n;
    for (;;) {
      const x = this.nextUint32();
      if (x < limit) return x % n;
    }
  }

  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(items: readonly T[]): T[] {
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
}
