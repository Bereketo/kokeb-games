import { describe, expect, it } from "vitest";
import { HashChain } from "../provably-fair/hash-chain.ts";
import { crashPointFromHash } from "./crash-point.ts";
import { msToReach, multiplierAt } from "./multiplier.ts";

describe("crash point", () => {
  const SALT = "0000000000000000000301e2801a9a9598bfb114e574a91a887f2132f33047e6";
  const N = 200_000;
  const chain = HashChain.fromSecret("statistics-secret-0123456789abcdefghijkl", N);
  const points = Array.from({ length: N }, (_, i) => crashPointFromHash(chain.hashForGame(i + 1), SALT, 300));

  it("is never below 1.00x and is deterministic", () => {
    expect(points.every((p) => p >= 100)).toBe(true);
    expect(crashPointFromHash(chain.hashForGame(1), SALT, 300)).toBe(points[0]);
  });

  it("changes with the salt", () => {
    const other = crashPointFromHash(chain.hashForGame(1), "different-salt", 300);
    const same = Array.from({ length: 50 }, (_, i) => crashPointFromHash(chain.hashForGame(i + 1), "different-salt", 300) === points[i]);
    expect(same.filter(Boolean).length).toBeLessThan(25);
    expect(typeof other).toBe("number");
  });

  // With a 3% edge, P(crash >= m) = 0.97 / m, so a player always cashing out
  // at target m gets back about 97% of what they bet, whatever m is.
  it.each([110, 150, 200, 500, 1000])("player return at %i hundredths is about 97%", (target) => {
    const wins = points.filter((p) => p >= target).length;
    const rtp = (wins * target) / 100 / N;
    expect(rtp).toBeGreaterThan(0.95);
    expect(rtp).toBeLessThan(0.99);
  });

  // 1.00x covers every raw value below 1.01x: 1 - 0.97 / 1.01 = 3.96%.
  it("instant crashes at 1.00x happen about 4% of the time", () => {
    const instant = points.filter((p) => p === 100).length / N;
    expect(instant).toBeGreaterThan(0.035);
    expect(instant).toBeLessThan(0.044);
  });
});

describe("multiplier curve", () => {
  it("starts at 1.00x and grows", () => {
    expect(multiplierAt(0)).toBe(100);
    expect(multiplierAt(11_553)).toBeGreaterThanOrEqual(199);
    expect(multiplierAt(11_553)).toBeLessThanOrEqual(200);
  });

  it("msToReach is the exact first moment a multiplier is reached", () => {
    for (const m of [101, 150, 200, 235, 1000, 12345]) {
      const ms = msToReach(m);
      expect(multiplierAt(ms)).toBeGreaterThanOrEqual(m);
      expect(multiplierAt(ms - 1)).toBeLessThan(m);
    }
  });
});
