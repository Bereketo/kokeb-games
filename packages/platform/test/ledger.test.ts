import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { isWalletError } from "@kokeb/wallet-contract";
import { InProcessWallet } from "../src/in-process-wallet.ts";
import { Ledger } from "../src/ledger.ts";
import { normalizeEthiopianPhone, upsertPlayer } from "../src/players.ts";
import { newPlayer, testDb } from "./helpers.ts";

const db = testDb();
const ledger = new Ledger(db);
const wallet = new InProcessWallet(ledger);
afterAll(() => db.$disconnect());

describe("ledger", () => {
  it("credits a deposit once per payment reference", async () => {
    const p = await newPlayer(db, ledger);
    const reference = `chapa-${randomUUID()}`;
    await ledger.deposit({ playerId: p, amount: 50_000n, source: "chapa", reference });
    const again = await ledger.deposit({ playerId: p, amount: 50_000n, source: "chapa", reference });
    expect(again.duplicate).toBe(true);
    expect(await ledger.balance(p, "ETB")).toBe(50_000n);
    await expect(ledger.deposit({ playerId: p, amount: 1n, source: "chapa", reference })).rejects.toSatisfy((e) =>
      isWalletError(e, "TX_CONFLICT"),
    );
  });

  it("refuses bets from a blocked player but still pays an open round", async () => {
    const p = await newPlayer(db, ledger, 1_000n);
    const round = randomUUID();
    await wallet.debit({ txId: randomUUID(), playerId: p, currency: "ETB", amount: 100n, gameId: "g", roundId: round });
    await db.player.update({ where: { id: p }, data: { status: "SELF_EXCLUDED" } });
    await expect(
      wallet.debit({ txId: randomUUID(), playerId: p, currency: "ETB", amount: 100n, gameId: "g", roundId: randomUUID() }),
    ).rejects.toSatisfy((e) => isWalletError(e, "PLAYER_BLOCKED"));
    const win = await wallet.credit({ txId: randomUUID(), playerId: p, currency: "ETB", amount: 500n, gameId: "g", roundId: round });
    expect(win.balance).toBe(1_400n);
  });

  it("keeps each game provider's txIds separate", async () => {
    const p = await newPlayer(db, ledger, 1_000n);
    const external = new InProcessWallet(ledger, { providerId: "some-studio" });
    const txId = randomUUID();
    await wallet.debit({ txId, playerId: p, currency: "ETB", amount: 100n, gameId: "g", roundId: randomUUID() });
    const r = await external.debit({ txId, playerId: p, currency: "ETB", amount: 100n, gameId: "g2", roundId: randomUUID() });
    expect(r.duplicate).toBe(false);
    expect(r.balance).toBe(800n);
  });

  it("the database refuses a negative player balance even if code tried", async () => {
    const p = await newPlayer(db, ledger, 100n);
    await expect(
      db.$executeRaw`UPDATE platform.accounts SET balance = -1 WHERE player_id = ${p}::uuid AND currency = 'ETB'`,
    ).rejects.toThrow(/accounts_balance_non_negative/);
  });

  it("the database refuses edits to ledger history", async () => {
    await newPlayer(db, ledger, 100n);
    await expect(db.$executeRaw`UPDATE platform.ledger_entries SET amount = amount + 1`).rejects.toThrow(/append-only/);
    await expect(db.$executeRaw`DELETE FROM platform.ledger_entries`).rejects.toThrow(/append-only/);
  });

  it("the books balance", async () => {
    expect(await ledger.verifyIntegrity()).toEqual([]);
  });
});

describe("players", () => {
  it("normalizes Ethiopian phone numbers", () => {
    expect(normalizeEthiopianPhone("+251 91 122 3344")).toBe("251911223344");
    expect(normalizeEthiopianPhone("0911223344")).toBe("251911223344");
    expect(normalizeEthiopianPhone("711223344")).toBe("251711223344");
    expect(normalizeEthiopianPhone("12345")).toBeNull();
  });

  it("upsert creates once and refreshes details", async () => {
    const telegramId = BigInt(Date.now()) * 10n;
    const a = await upsertPlayer(db, { telegramId, firstName: "Abebe", phone: "0911000001" });
    const b = await upsertPlayer(db, { telegramId, firstName: "Abebe", username: "abebe_k" });
    expect(b.id).toBe(a.id);
    expect(b.username).toBe("abebe_k");
    expect(b.phone).toBe("251911000001");
    await db.player.delete({ where: { id: a.id } });
  });
});
