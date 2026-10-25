import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "./signature.ts";

describe("request signatures", () => {
  const secret = "s3cret";
  const body = '{"playerId":"p1","amount":"400"}';
  const now = 1_800_000_000;

  it("accepts a correctly signed, fresh request", () => {
    const sig = signBody(secret, body, now);
    expect(verifySignature({ secret, rawBody: body, timestamp: String(now), signature: sig, nowSeconds: now })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const sig = signBody(secret, body, now);
    expect(verifySignature({ secret, rawBody: body.replace("400", "40000"), timestamp: now, signature: sig, nowSeconds: now })).toBe(false);
  });

  it("rejects the wrong secret, stale timestamps and junk", () => {
    const sig = signBody(secret, body, now);
    expect(verifySignature({ secret: "other", rawBody: body, timestamp: now, signature: sig, nowSeconds: now })).toBe(false);
    expect(verifySignature({ secret, rawBody: body, timestamp: now, signature: sig, nowSeconds: now + 301 })).toBe(false);
    expect(verifySignature({ secret, rawBody: body, timestamp: now, signature: "zz", nowSeconds: now })).toBe(false);
    expect(verifySignature({ secret, rawBody: body, timestamp: undefined, signature: sig, nowSeconds: now })).toBe(false);
  });
});
