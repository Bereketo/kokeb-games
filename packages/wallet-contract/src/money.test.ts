import { describe, expect, it } from "vitest";
import { formatMinor, parseMajor } from "./money.ts";

describe("money", () => {
  it("parses birr into santim", () => {
    expect(parseMajor("12")).toBe(1200n);
    expect(parseMajor("12.5")).toBe(1250n);
    expect(parseMajor("0.07")).toBe(7n);
    expect(() => parseMajor("1.234")).toThrow();
    expect(() => parseMajor("abc")).toThrow();
  });
  it("formats santim as birr", () => {
    expect(formatMinor(1250n)).toBe("12.50");
    expect(formatMinor(7n)).toBe("0.07");
    expect(formatMinor(-1999n)).toBe("-19.99");
  });
});
