/**
 * Wallet conformance suite.
 *
 * Any WalletPort implementation (the in-process ledger, the HTTP client, a
 * future third-party integration) must pass this exact suite. Call it from a
 * vitest test file:
 *
 *   runWalletConformance("InProcessWallet", async () => ({ wallet, createPlayer, demoGrant }));
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WalletError, type WalletErrorCode } from "./errors.ts";
import type { Currency, WalletPort } from "./types.ts";

export interface ConformanceHarness {
  wallet: WalletPort;
  /** Create a brand-new player holding `etb` minor units of real money. */
  createPlayer(opts?: { etb?: bigint }): Promise<string>;
  /** DEMO balance every player starts with. */
  demoGrant: bigint;
  /** Optional: throw if the underlying books don't balance. */
  verifyIntegrity?(): Promise<void>;
  teardown?(): Promise<void>;
}

const id = () => randomUUID();

async function expectWalletError(p: Promise<unknown>, code: WalletErrorCode): Promise<void> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(WalletError);
    expect((err as WalletError).code).toBe(code);
    return;
  }
  throw new Error(`Expected WalletError ${code}, but the call succeeded`);
}

export function runWalletConformance(name: string, setup: () => Promise<ConformanceHarness>): void {
  describe(`wallet conformance: ${name}`, () => {
    let h: ConformanceHarness;
    const game = "conformance-game";

    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      await h?.verifyIntegrity?.();
      await h?.teardown?.();
    });

    const bal = async (playerId: string, currency: Currency = "ETB") =>
      (await h.wallet.balance({ playerId, currency })).balance;

    const debit = (playerId: string, amount: bigint, extra: Partial<{ txId: string; roundId: string; currency: Currency }> = {}) =>
      h.wallet.debit({ txId: extra.txId ?? id(), playerId, amount, currency: extra.currency ?? "ETB", gameId: game, roundId: extra.roundId ?? id() });

    const credit = (playerId: string, amount: bigint, roundId: string, extra: Partial<{ txId: string; currency: Currency }> = {}) =>
      h.wallet.credit({ txId: extra.txId ?? id(), playerId, amount, currency: extra.currency ?? "ETB", gameId: game, roundId });

    const rollback = (playerId: string, originalTxId: string, roundId: string, extra: Partial<{ txId: string; currency: Currency }> = {}) =>
      h.wallet.rollback({ txId: extra.txId ?? id(), playerId, originalTxId, currency: extra.currency ?? "ETB", gameId: game, roundId });

    describe("balance", () => {
      it("returns the funded real balance", async () => {
        const p = await h.createPlayer({ etb: 5000n });
        expect(await bal(p)).toBe(5000n);
      });

      it("gives every player the demo grant", async () => {
        const p = await h.createPlayer();
        expect(await bal(p, "DEMO")).toBe(h.demoGrant);
      });

      it("rejects unknown players", async () => {
        await expectWalletError(h.wallet.balance({ playerId: id(), currency: "ETB" }), "PLAYER_NOT_FOUND");
      });
    });

    describe("debit and credit", () => {
      it("a bet then a win moves the balance correctly", async () => {
        const p = await h.createPlayer({ etb: 10_000n });
        const round = id();
        const d = await debit(p, 400n, { roundId: round });
        expect(d.balance).toBe(9_600n);
        expect(d.duplicate).toBe(false);
        const c = await credit(p, 1_000n, round);
        expect(c.balance).toBe(10_600n);
        expect(await bal(p)).toBe(10_600n);
      });

      it("a zero credit (a loss) is accepted", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await debit(p, 1_000n, { roundId: round });
        const c = await credit(p, 0n, round);
        expect(c.balance).toBe(0n);
      });

      it("rejects a bet larger than the balance and leaves it untouched", async () => {
        const p = await h.createPlayer({ etb: 300n });
        await expectWalletError(debit(p, 301n), "INSUFFICIENT_FUNDS");
        expect(await bal(p)).toBe(300n);
      });

      it("rejects zero/negative debits and negative credits", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await expectWalletError(debit(p, 0n), "INVALID_REQUEST");
        await expectWalletError(debit(p, -5n), "INVALID_REQUEST");
        await debit(p, 100n, { roundId: round });
        await expectWalletError(credit(p, -1n, round), "INVALID_REQUEST");
      });

      it("rejects operations for unknown players", async () => {
        await expectWalletError(debit(id(), 100n), "PLAYER_NOT_FOUND");
      });

      it("rejects a credit for a round with no debit", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        await expectWalletError(credit(p, 500n, id()), "ROUND_NOT_FOUND");
        expect(await bal(p)).toBe(1_000n);
      });
    });

    describe("idempotency", () => {
      it("a repeated debit is charged once and flagged as duplicate", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const txId = id();
        const round = id();
        const first = await debit(p, 200n, { txId, roundId: round });
        const again = await debit(p, 200n, { txId, roundId: round });
        expect(again.duplicate).toBe(true);
        expect(again.walletTxId).toBe(first.walletTxId);
        expect(await bal(p)).toBe(800n);
      });

      it("a repeated credit is paid once", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await debit(p, 100n, { roundId: round });
        const txId = id();
        await credit(p, 500n, round, { txId });
        const again = await credit(p, 500n, round, { txId });
        expect(again.duplicate).toBe(true);
        expect(await bal(p)).toBe(1_400n);
      });

      it("reusing a txId with a different payload is a conflict", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const txId = id();
        const round = id();
        await debit(p, 100n, { txId, roundId: round });
        await expectWalletError(debit(p, 999n, { txId, roundId: round }), "TX_CONFLICT");
        expect(await bal(p)).toBe(900n);
      });

      it("txIds are scoped per player", async () => {
        const a = await h.createPlayer({ etb: 1_000n });
        const b = await h.createPlayer({ etb: 1_000n });
        const txId = id();
        await debit(a, 100n, { txId });
        const r = await debit(b, 100n, { txId });
        expect(r.duplicate).toBe(false);
        expect(await bal(a)).toBe(900n);
        expect(await bal(b)).toBe(900n);
      });
    });

    describe("rollback", () => {
      it("refunds a debit, once", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const d = await debit(p, 400n, { roundId: round });
        const rbId = id();
        const r = await rollback(p, d.txId, round, { txId: rbId });
        expect(r.balance).toBe(1_000n);
        const again = await rollback(p, d.txId, round, { txId: rbId });
        expect(again.duplicate).toBe(true);
        expect(await bal(p)).toBe(1_000n);
      });

      it("a second rollback of the same debit under a new txId does not refund twice", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const d = await debit(p, 400n, { roundId: round });
        await rollback(p, d.txId, round);
        const r2 = await rollback(p, d.txId, round);
        expect(r2.duplicate).toBe(true);
        expect(await bal(p)).toBe(1_000n);
      });

      it("rollback of an unknown debit is recorded, and the late debit is then refused", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const lostDebitId = id();
        const r = await rollback(p, lostDebitId, round);
        expect(r.balance).toBe(1_000n);
        await expectWalletError(debit(p, 300n, { txId: lostDebitId, roundId: round }), "TX_ALREADY_ROLLED_BACK");
        expect(await bal(p)).toBe(1_000n);
      });

      it("credits cannot be rolled back", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await debit(p, 100n, { roundId: round });
        const c = await credit(p, 300n, round);
        await expectWalletError(rollback(p, c.txId, round), "ROLLBACK_NOT_ALLOWED");
        expect(await bal(p)).toBe(1_200n);
      });

      it("a round whose only debit was rolled back cannot be credited", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const d = await debit(p, 100n, { roundId: round });
        await rollback(p, d.txId, round);
        await expectWalletError(credit(p, 500n, round), "ROUND_NOT_FOUND");
        expect(await bal(p)).toBe(1_000n);
      });

      it("rollback currency must match the debit", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const d = await debit(p, 100n, { roundId: round });
        await expectWalletError(rollback(p, d.txId, round, { currency: "DEMO" }), "INVALID_REQUEST");
        expect(await bal(p)).toBe(900n);
      });
    });

    describe("demo money", () => {
      it("is completely separate from real money", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await debit(p, 500n, { roundId: round, currency: "DEMO" });
        await credit(p, 2_000n, round, { currency: "DEMO" });
        expect(await bal(p, "DEMO")).toBe(h.demoGrant + 1_500n);
        expect(await bal(p, "ETB")).toBe(1_000n);
      });

      it("a demo round cannot be credited in real money", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        await debit(p, 500n, { roundId: round, currency: "DEMO" });
        await expectWalletError(credit(p, 5_000n, round, { currency: "ETB" }), "ROUND_NOT_FOUND");
        expect(await bal(p, "ETB")).toBe(1_000n);
      });
    });

    describe("concurrency", () => {
      it("parallel bets never overdraw the balance", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const results = await Promise.allSettled(Array.from({ length: 25 }, () => debit(p, 100n)));
        const ok = results.filter((r) => r.status === "fulfilled").length;
        const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
        expect(ok).toBe(10);
        for (const f of failed) expect((f.reason as WalletError).code).toBe("INSUFFICIENT_FUNDS");
        expect(await bal(p)).toBe(0n);
      });

      it("parallel retries of the same debit charge exactly once", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const txId = id();
        const round = id();
        const results = await Promise.all(Array.from({ length: 10 }, () => debit(p, 250n, { txId, roundId: round })));
        expect(new Set(results.map((r) => r.walletTxId)).size).toBe(1);
        expect(results.filter((r) => !r.duplicate).length).toBe(1);
        expect(await bal(p)).toBe(750n);
      });

      it("a debit and its rollback racing never lose or create money", async () => {
        const p = await h.createPlayer({ etb: 1_000n });
        const round = id();
        const txId = id();
        await Promise.allSettled([debit(p, 600n, { txId, roundId: round }), rollback(p, txId, round)]);
        // Whichever order they ran in, the debit must end up reversed or refused.
        expect(await bal(p)).toBe(1_000n);
      });
    });
  });
}
