import { describe, expect, it } from "vitest";
import { SeededRng } from "../common/rng.ts";
import { BALLS, FREE, PATTERNS, buildDeck, drawOrder, firstWinningCall, letterFor, seedHash, winningPattern } from "./cards.ts";

describe("cartelas", () => {
  const deck = buildDeck("public-deck-seed", 400);

  it("every card follows 75-ball rules: B 1-15, I 16-30, N 31-45, G 46-60, O 61-75, free center", () => {
    for (const card of deck) {
      expect(card.length).toBe(25);
      expect(card[12]).toBe(FREE);
      for (let i = 0; i < 25; i++) {
        if (i === 12) continue;
        const col = i % 5;
        expect(card[i]).toBeGreaterThanOrEqual(col * 15 + 1);
        expect(card[i]).toBeLessThanOrEqual(col * 15 + 15);
      }
      expect(new Set(card).size).toBe(25);
    }
  });

  it("card #N is the same every time, and all cards differ", () => {
    expect(buildDeck("public-deck-seed", 400)[36]).toEqual(deck[36]);
    expect(new Set(deck.map((c) => c.join(","))).size).toBe(400);
    expect(buildDeck("other-seed", 1)[0]).not.toEqual(deck[0]);
  });
});

describe("patterns", () => {
  const card = buildDeck("public-deck-seed", 1)[0]!;
  const call = (idx: number[]) => new Set(idx.map((i) => card[i]!).filter((n) => n !== FREE));

  it("has 5 rows, 5 columns, 2 diagonals and four corners", () => {
    expect(PATTERNS.length).toBe(13);
  });

  it("recognises each pattern, using the free center", () => {
    expect(winningPattern(card, call([10, 11, 13, 14]))?.name).toBe("row 3"); // center row needs only 4
    expect(winningPattern(card, call([2, 7, 17, 22]))?.name).toBe("column N");
    expect(winningPattern(card, call([0, 6, 18, 24]))?.name).toBe("diagonal");
    expect(winningPattern(card, call([0, 4, 20, 24]))?.name).toBe("four corners");
    expect(winningPattern(card, call([0, 1, 2, 3]))).toBeNull(); // 4 of 5 in row 1
  });

  it("every card wins by the 75th ball", () => {
    const order = drawOrder("x");
    for (const c of buildDeck("d", 50)) expect(firstWinningCall(c, order)).toBeLessThanOrEqual(75);
  });
});

describe("draw", () => {
  it("is a full shuffle of 1-75, fixed by the seed, and committed by its hash", () => {
    const a = drawOrder("seed-1");
    expect([...a].sort((x, y) => x - y)).toEqual(Array.from({ length: BALLS }, (_, i) => i + 1));
    expect(drawOrder("seed-1")).toEqual(a);
    expect(drawOrder("seed-2")).not.toEqual(a);
    expect(seedHash("seed-1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is unbiased: each ball is equally likely to come first", () => {
    const counts = new Array(76).fill(0);
    const N = 7_500; // ~100 per ball; a biased shuffle would be far outside the bounds
    for (let i = 0; i < N; i++) counts[drawOrder(`s${i}`)[0]!]++;
    const expected = N / 75;
    for (let b = 1; b <= 75; b++) {
      expect(counts[b]).toBeGreaterThan(expected * 0.6);
      expect(counts[b]).toBeLessThan(expected * 1.4);
    }
  });

  it("letters match columns", () => {
    expect([1, 15, 16, 45, 46, 75].map(letterFor)).toEqual(["B", "B", "I", "N", "G", "O"]);
  });

  it("the seeded RNG gives uniform integers", () => {
    const rng = new SeededRng("k", "t");
    const counts = [0, 0, 0];
    for (let i = 0; i < 9000; i++) counts[rng.int(3)]!++;
    for (const c of counts) expect(c).toBeGreaterThan(2700);
  });
});
