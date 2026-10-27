/**
 * 75-ball bingo cards ("cartelas"), winning patterns, and the draw.
 *
 * A card is 25 numbers, row by row; the center (index 12) is the free
 * space, stored as 0. Columns: B 1–15, I 16–30, N 31–45, G 46–60, O 61–75.
 *
 * Cartelas are FIXED: card #N is generated from the public deck seed and N,
 * so "card 37" is the same card in every game and anyone can recompute it.
 *
 * The draw order is a seeded shuffle of 1..75. Its seed is secret until the
 * game ends, but its SHA-256 is published before anyone picks a card.
 */
import { createHash } from "node:crypto";
import { SeededRng } from "../common/rng.ts";

export type Card = readonly number[]; // length 25, 0 = free space
export const FREE = 0;
export const BALLS = 75;
export const LETTERS = ["B", "I", "N", "G", "O"] as const;

export function letterFor(ball: number): (typeof LETTERS)[number] {
  return LETTERS[Math.floor((ball - 1) / 15)]!;
}

/** Card for number `n` in a deck. Unique within the deck (collisions re-rolled). */
function rawCard(deckSeed: string, n: number, attempt: number): number[] {
  const rng = new SeededRng(deckSeed, `card:${n}:${attempt}`);
  const columns = [0, 1, 2, 3, 4].map((col) => {
    const pool = Array.from({ length: 15 }, (_, i) => col * 15 + i + 1);
    return rng.shuffle(pool).slice(0, 5);
  });
  const card: number[] = [];
  for (let row = 0; row < 5; row++) for (let col = 0; col < 5; col++) card.push(columns[col]![row]!);
  card[12] = FREE;
  return card;
}

/** All cards 1..count of a deck, guaranteed distinct. */
export function buildDeck(deckSeed: string, count: number): Card[] {
  if (!deckSeed) throw new Error("deck seed required");
  const seen = new Set<string>();
  const deck: Card[] = [];
  for (let n = 1; n <= count; n++) {
    for (let attempt = 0; ; attempt++) {
      const card = rawCard(deckSeed, n, attempt);
      const sig = [...card].sort((a, b) => a - b).join(",");
      if (!seen.has(sig)) {
        seen.add(sig);
        deck.push(card);
        break;
      }
    }
  }
  return deck;
}

/** The 13 winning patterns, as card indexes. */
export const PATTERNS: readonly { name: string; cells: readonly number[] }[] = [
  ...[0, 1, 2, 3, 4].map((r) => ({ name: `row ${r + 1}`, cells: [0, 1, 2, 3, 4].map((c) => r * 5 + c) })),
  ...[0, 1, 2, 3, 4].map((c) => ({ name: `column ${LETTERS[c]}`, cells: [0, 1, 2, 3, 4].map((r) => r * 5 + c) })),
  { name: "diagonal", cells: [0, 6, 12, 18, 24] },
  { name: "diagonal", cells: [4, 8, 12, 16, 20] },
  { name: "four corners", cells: [0, 4, 20, 24] },
];

/** The first pattern the card completes with these called balls, or null. */
export function winningPattern(card: Card, called: ReadonlySet<number>): { name: string; cells: readonly number[] } | null {
  const marked = (i: number) => card[i] === FREE || called.has(card[i]!);
  for (const p of PATTERNS) if (p.cells.every(marked)) return p;
  return null;
}

/**
 * The call index (1-based) at which this card first wins, given a draw order.
 * Every card wins by ball 75 at the latest.
 */
export function firstWinningCall(card: Card, order: readonly number[]): number {
  const called = new Set<number>();
  for (let i = 0; i < order.length; i++) {
    called.add(order[i]!);
    if (winningPattern(card, called)) return i + 1;
  }
  return order.length;
}

// ── the draw ──

export function seedHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

/** Draw order for a game seed: a shuffle of 1..75. */
export function drawOrder(seed: string): number[] {
  return new SeededRng(seed, "draw").shuffle(Array.from({ length: BALLS }, (_, i) => i + 1));
}
