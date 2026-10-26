import { describe, expect, it } from "vitest";
import { HashChain, sha256, verifyChainLink } from "./hash-chain.ts";

describe("hash chain", () => {
  const chain = HashChain.fromSecret("a-very-long-test-secret-0123456789abcdef", 1000);

  it("each revealed game hash links to the previous one and finally to the commitment", () => {
    expect(verifyChainLink(chain.hashForGame(1), chain.commitment)).toBe(true);
    for (let g = 2; g <= 1000; g++) expect(verifyChainLink(chain.hashForGame(g), chain.hashForGame(g - 1))).toBe(true);
  });

  it("is deterministic from the secret and differs for another secret", () => {
    const again = HashChain.fromSecret("a-very-long-test-secret-0123456789abcdef", 1000);
    const other = HashChain.fromSecret("another-very-long-test-secret-0123456789", 1000);
    expect(again.commitment).toBe(chain.commitment);
    expect(other.commitment).not.toBe(chain.commitment);
  });

  it("refuses games outside the chain and weak secrets", () => {
    expect(() => chain.hashForGame(0)).toThrow();
    expect(() => chain.hashForGame(1001)).toThrow();
    expect(() => HashChain.fromSecret("short", 10)).toThrow();
  });

  it("does not reveal a future game from a past one", () => {
    // Knowing game 5's hash only lets you compute games 4..1, never game 6.
    expect(sha256(Buffer.from(chain.hashForGame(5), "hex")).toString("hex")).toBe(chain.hashForGame(4));
    expect(sha256(Buffer.from(chain.hashForGame(5), "hex")).toString("hex")).not.toBe(chain.hashForGame(6));
  });
});
