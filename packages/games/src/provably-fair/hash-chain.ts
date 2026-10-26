/**
 * Hash chain for provably-fair rounds (the bustabit model).
 *
 *   h[0]   = SHA-256(secret)
 *   h[i+1] = SHA-256(h[i])          (hashing the raw 32 bytes)
 *   published commitment = h[N]
 *
 * Rounds consume the chain BACKWARDS: game 1 uses h[N-1], game 2 uses h[N-2]...
 * Because SHA-256 can't be reversed, publishing h[N] before any round locks in
 * every future result without revealing it. After each round its hash is
 * revealed, and anyone can check SHA-256(hash of game k) == hash of game k-1
 * (and SHA-256(hash of game 1) == the commitment).
 *
 * The whole chain lives in one Buffer (32 bytes per game: 32 MB for 1M games).
 */
import { createHash } from "node:crypto";

const HASH_BYTES = 32;

export function sha256(data: Buffer | string): Buffer {
  return createHash("sha256").update(data).digest();
}

export class HashChain {
  readonly length: number;
  private readonly buf: Buffer;

  private constructor(buf: Buffer, length: number) {
    this.buf = buf;
    this.length = length;
  }

  /** Rebuild the chain from its secret. ~1 s per million games. */
  static fromSecret(secret: string, length: number): HashChain {
    if (!secret || secret.length < 32) throw new Error("chain secret must be at least 32 characters");
    if (!Number.isInteger(length) || length < 1) throw new Error("chain length must be a positive integer");
    const buf = Buffer.allocUnsafe((length + 1) * HASH_BYTES);
    let h = sha256(secret);
    h.copy(buf, 0);
    for (let i = 1; i <= length; i++) {
      h = sha256(h);
      h.copy(buf, i * HASH_BYTES);
    }
    return new HashChain(buf, length);
  }

  /** The public commitment h[N]. Publish it before the first round. */
  get commitment(): string {
    return this.at(this.length);
  }

  /** Hash (hex) used by game number `game` (1-based). */
  hashForGame(game: number): string {
    if (!Number.isInteger(game) || game < 1 || game > this.length) {
      throw new Error(`game ${game} is outside the chain (1..${this.length}); generate a new chain`);
    }
    return this.at(this.length - game);
  }

  private at(i: number): string {
    return this.buf.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES).toString("hex");
  }
}

/** Public check: does `gameHash` (game k) hash to `nextHash` (game k-1, or the commitment for k=1)? */
export function verifyChainLink(gameHash: string, nextHash: string): boolean {
  return sha256(Buffer.from(gameHash, "hex")).toString("hex") === nextHash.toLowerCase();
}
