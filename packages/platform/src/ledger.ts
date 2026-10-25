/**
 * The Kokeb ledger: double-entry bookkeeping for every birr (and demo coin)
 * that moves on the platform.
 *
 * How it stays safe:
 *  - Every money movement is one LedgerTransaction whose entries sum to zero.
 *  - Each operation runs in a DB transaction that first locks the player's
 *    account row (SELECT ... FOR UPDATE). All operations for one player are
 *    therefore strictly serialized: no double spends, no lost updates, and
 *    duplicate/racing requests see each other's results.
 *  - Idempotency key: (source, playerId, externalTxId), unique in the DB.
 *  - The DB itself refuses negative player balances (CHECK constraint) and
 *    any change to past ledger entries (append-only trigger).
 *  - Only player accounts keep a cached balance. House accounts would be a
 *    single hot row touched by every bet, so their balance is derived from
 *    their entries instead.
 */
import { Prisma, type Currency, type Db, type LedgerTransaction, type LedgerTxType } from "@kokeb/db";
import {
  WalletError,
  type CreditRequest,
  type DebitRequest,
  type RollbackRequest,
  type TxResult,
} from "@kokeb/wallet-contract";

type Tx = Prisma.TransactionClient;

type SystemAccountKind = "HOUSE_GAMING" | "CASH_CLEARING" | "DEMO_FAUCET";

interface LockedAccount {
  id: string;
  balance: bigint;
  status: string;
}

export interface LedgerOptions {
  /** Play money every player receives the first time they open a demo game. Default 10,000 DEMO. */
  demoGrant?: bigint;
  /** Max time (ms) an operation may wait for a DB connection/lock. Default 10s. */
  timeoutMs?: number;
}

/** The ledger's own source id, used for platform-initiated transactions. */
export const PLATFORM_SOURCE = "kokeb-platform";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 128;

export class Ledger {
  readonly demoGrant: bigint;
  private readonly db: Db;
  private readonly timeoutMs: number;
  private readonly systemAccountIds = new Map<string, string>();

  constructor(db: Db, opts: LedgerOptions = {}) {
    this.db = db;
    this.demoGrant = opts.demoGrant ?? 1_000_000n; // 10,000.00 DEMO
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  // ───────────────────────── wallet operations ─────────────────────────

  async balance(playerId: string, currency: Currency): Promise<bigint> {
    return this.inTx(async (tx) => (await this.lockPlayerAccount(tx, playerId, currency, false)).balance);
  }

  /** A game takes a stake. `source` is the game provider id. */
  async debit(source: string, req: DebitRequest): Promise<TxResult> {
    validateTx(req);
    if (req.amount <= 0n) throw new WalletError("INVALID_REQUEST", "debit amount must be > 0");

    return this.inTx(async (tx) => {
      const acct = await this.lockPlayerAccount(tx, req.playerId, req.currency);

      const existing = await findTx(tx, source, req.playerId, req.txId);
      if (existing) {
        if (existing.type === "BET" && sameGameTx(existing, req)) return dup(req, existing, acct.balance);
        throw new WalletError("TX_CONFLICT", `txId ${req.txId} was already used with a different payload`);
      }

      const tombstone = await tx.ledgerTransaction.findFirst({
        where: { source, playerId: req.playerId, type: "ROLLBACK", originalExternalTxId: req.txId },
      });
      if (tombstone) throw new WalletError("TX_ALREADY_ROLLED_BACK", `debit ${req.txId} was already rolled back`);

      if (acct.status !== "ACTIVE") throw new WalletError("PLAYER_BLOCKED");
      if (acct.balance < req.amount) throw new WalletError("INSUFFICIENT_FUNDS");

      const house = await this.systemAccount(tx, "HOUSE_GAMING", req.currency);
      const { ledgerTx, balance } = await this.post(tx, {
        type: "BET",
        source,
        req,
        amount: req.amount,
        player: acct,
        playerDelta: -req.amount,
        counterAccountId: house,
      });
      return result(req, ledgerTx.id, balance, false);
    });
  }

  /** A game pays out a round (amount may be 0 for a loss). */
  async credit(source: string, req: CreditRequest): Promise<TxResult> {
    validateTx(req);
    if (req.amount < 0n) throw new WalletError("INVALID_REQUEST", "credit amount must be >= 0");

    return this.inTx(async (tx) => {
      const acct = await this.lockPlayerAccount(tx, req.playerId, req.currency);

      const existing = await findTx(tx, source, req.playerId, req.txId);
      if (existing) {
        if (existing.type === "WIN" && sameGameTx(existing, req)) return dup(req, existing, acct.balance);
        throw new WalletError("TX_CONFLICT", `txId ${req.txId} was already used with a different payload`);
      }

      const liveBet = await tx.ledgerTransaction.findFirst({
        where: {
          source,
          playerId: req.playerId,
          roundId: req.roundId,
          currency: req.currency,
          type: "BET",
          rolledBack: false,
        },
        select: { id: true },
      });
      if (!liveBet) throw new WalletError("ROUND_NOT_FOUND", `no live debit for round ${req.roundId}`);

      // Wins are always paid, even to a player blocked mid-round.
      const house = await this.systemAccount(tx, "HOUSE_GAMING", req.currency);
      const { ledgerTx, balance } = await this.post(tx, {
        type: "WIN",
        source,
        req,
        amount: req.amount,
        player: acct,
        playerDelta: req.amount,
        counterAccountId: house,
      });
      return result(req, ledgerTx.id, balance, false);
    });
  }

  /** A game reverses a debit. Unknown debits leave a tombstone that blocks them later. */
  async rollback(source: string, req: RollbackRequest): Promise<TxResult> {
    validateTx(req);
    validateId("originalTxId", req.originalTxId);

    return this.inTx(async (tx) => {
      const acct = await this.lockPlayerAccount(tx, req.playerId, req.currency);

      const existing = await findTx(tx, source, req.playerId, req.txId);
      if (existing) {
        if (existing.type === "ROLLBACK" && existing.originalExternalTxId === req.originalTxId) {
          return dup(req, existing, acct.balance);
        }
        throw new WalletError("TX_CONFLICT", `txId ${req.txId} was already used with a different payload`);
      }

      const original = await findTx(tx, source, req.playerId, req.originalTxId);
      const priorRollback = await tx.ledgerTransaction.findFirst({
        where: { source, playerId: req.playerId, type: "ROLLBACK", originalExternalTxId: req.originalTxId },
      });

      if (original) {
        if (original.type !== "BET") {
          throw new WalletError("ROLLBACK_NOT_ALLOWED", `only debits can be rolled back (${req.originalTxId} is ${original.type})`);
        }
        if (original.currency !== req.currency) {
          throw new WalletError("INVALID_REQUEST", "rollback currency does not match the debit");
        }
        if (original.rolledBack && priorRollback) return dup(req, priorRollback, acct.balance);

        const house = await this.systemAccount(tx, "HOUSE_GAMING", req.currency);
        const { ledgerTx, balance } = await this.post(tx, {
          type: "ROLLBACK",
          source,
          req,
          amount: original.amount,
          originalExternalTxId: req.originalTxId,
          player: acct,
          playerDelta: original.amount,
          counterAccountId: house,
        });
        await tx.ledgerTransaction.update({ where: { id: original.id }, data: { rolledBack: true } });
        return result(req, ledgerTx.id, balance, false);
      }

      if (priorRollback) return dup(req, priorRollback, acct.balance);

      // Unknown debit: record a zero-amount tombstone so the debit is refused if it shows up later.
      const tombstone = await tx.ledgerTransaction.create({
        data: {
          type: "ROLLBACK",
          currency: req.currency,
          source,
          playerId: req.playerId,
          externalTxId: req.txId,
          gameId: req.gameId,
          roundId: req.roundId,
          amount: 0n,
          originalExternalTxId: req.originalTxId,
        },
      });
      return result(req, tombstone.id, acct.balance, false);
    });
  }

  // ───────────────────────── platform operations ─────────────────────────

  /**
   * Credit a confirmed deposit. `reference` is the payment provider's
   * transaction reference, so a repeated webhook never credits twice.
   * Call this only AFTER verifying the payment with the provider's API.
   */
  async deposit(input: { playerId: string; amount: bigint; source: string; reference: string }): Promise<TxResult> {
    validateId("reference", input.reference);
    if (input.amount <= 0n) throw new WalletError("INVALID_REQUEST", "deposit amount must be > 0");
    const req = { txId: input.reference, playerId: input.playerId, currency: "ETB" as const };

    return this.inTx(async (tx) => {
      const acct = await this.lockPlayerAccount(tx, input.playerId, "ETB");
      const existing = await findTx(tx, input.source, input.playerId, input.reference);
      if (existing) {
        if (existing.type === "DEPOSIT" && existing.amount === input.amount) return dup(req, existing, acct.balance);
        throw new WalletError("TX_CONFLICT", `deposit reference ${input.reference} already used`);
      }
      const clearing = await this.systemAccount(tx, "CASH_CLEARING", "ETB");
      const { ledgerTx, balance } = await this.post(tx, {
        type: "DEPOSIT",
        source: input.source,
        req: { ...req, gameId: null, roundId: null },
        amount: input.amount,
        player: acct,
        playerDelta: input.amount,
        counterAccountId: clearing,
      });
      return result(req, ledgerTx.id, balance, false);
    });
  }

  /**
   * Reconciliation check. Returns a list of problems (empty = books balance).
   * Run it nightly and alert on any output.
   */
  async verifyIntegrity(): Promise<string[]> {
    const problems: string[] = [];

    const unbalanced = await this.db.$queryRaw<{ transaction_id: string; total: bigint }[]>`
      SELECT transaction_id, SUM(amount) AS total
      FROM platform.ledger_entries GROUP BY transaction_id HAVING SUM(amount) <> 0`;
    for (const r of unbalanced) problems.push(`transaction ${r.transaction_id} entries sum to ${r.total}, not 0`);

    const drifted = await this.db.$queryRaw<{ id: string; balance: bigint; computed: bigint }[]>`
      SELECT a.id, a.balance, COALESCE(e.total, 0)::bigint AS computed
      FROM platform.accounts a
      LEFT JOIN (SELECT account_id, SUM(amount) AS total FROM platform.ledger_entries GROUP BY account_id) e
        ON e.account_id = a.id
      WHERE a.kind = 'PLAYER' AND a.balance <> COALESCE(e.total, 0)`;
    for (const r of drifted) problems.push(`account ${r.id} balance ${r.balance} but entries sum to ${r.computed}`);

    const badAmounts = await this.db.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM platform.ledger_transactions t
      JOIN platform.ledger_entries e ON e.transaction_id = t.id
      JOIN platform.accounts a ON a.id = e.account_id AND a.kind = 'PLAYER'
      WHERE ABS(e.amount) <> t.amount`;
    for (const r of badAmounts) problems.push(`transaction ${r.id} amount does not match its player entry`);

    return problems;
  }

  // ───────────────────────── internals ─────────────────────────

  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.$transaction(fn, {
      maxWait: this.timeoutMs,
      timeout: this.timeoutMs,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  }

  /** Lock (or, for reads, just fetch) the player's account, creating it on first use. */
  private async lockPlayerAccount(tx: Tx, playerId: string, currency: Currency, forUpdate = true): Promise<LockedAccount> {
    if (!UUID_RE.test(playerId)) throw new WalletError("PLAYER_NOT_FOUND");

    const select = () => tx.$queryRaw<LockedAccount[]>`
      SELECT a.id, a.balance, p.status::text AS status
      FROM platform.accounts a JOIN platform.players p ON p.id = a.player_id
      WHERE a.player_id = ${playerId}::uuid AND a.currency = ${currency}::platform."Currency"
      ${forUpdate ? Prisma.sql`FOR UPDATE OF a` : Prisma.empty}`;

    let rows = await select();
    if (rows.length === 0) {
      await this.createPlayerAccount(tx, playerId, currency);
      rows = await select();
    }
    const row = rows[0];
    if (!row) throw new WalletError("INTERNAL", "player account could not be created");
    return row;
  }

  private async createPlayerAccount(tx: Tx, playerId: string, currency: Currency): Promise<void> {
    const player = await tx.player.findUnique({ where: { id: playerId }, select: { id: true } });
    if (!player) throw new WalletError("PLAYER_NOT_FOUND");

    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO platform.accounts (id, kind, currency, player_id, balance, allow_negative)
      VALUES (gen_random_uuid(), 'PLAYER', ${currency}::platform."Currency", ${playerId}::uuid, 0, false)
      ON CONFLICT (player_id, currency) DO NOTHING
      RETURNING id`;
    const accountId = inserted[0]?.id;

    // Only the transaction that created the demo account grants the play money.
    if (accountId && currency === "DEMO" && this.demoGrant > 0n) {
      const faucet = await this.systemAccount(tx, "DEMO_FAUCET", "DEMO");
      await this.post(tx, {
        type: "DEMO_GRANT",
        source: PLATFORM_SOURCE,
        req: { txId: `demo-grant:${playerId}`, playerId, currency: "DEMO", gameId: null, roundId: null },
        amount: this.demoGrant,
        player: { id: accountId, balance: 0n, status: "ACTIVE" },
        playerDelta: this.demoGrant,
        counterAccountId: faucet,
      });
    }
  }

  private async systemAccount(tx: Tx, kind: SystemAccountKind, currency: Currency): Promise<string> {
    const key = `${kind}:${currency}`;
    const cached = this.systemAccountIds.get(key);
    if (cached) return cached;

    await tx.$executeRaw`
      INSERT INTO platform.accounts (id, kind, currency, system_key, balance, allow_negative)
      VALUES (gen_random_uuid(), ${kind}::platform."AccountKind", ${currency}::platform."Currency", ${key}, 0, true)
      ON CONFLICT (system_key) DO NOTHING`;
    const acct = await tx.account.findUniqueOrThrow({ where: { systemKey: key }, select: { id: true } });
    this.systemAccountIds.set(key, acct.id);
    return acct.id;
  }

  /** Record one balanced transaction: player account <-> counter account. */
  private async post(
    tx: Tx,
    p: {
      type: LedgerTxType;
      source: string;
      req: { txId: string; playerId: string; currency: Currency; gameId: string | null; roundId: string | null };
      amount: bigint;
      originalExternalTxId?: string;
      player: LockedAccount;
      playerDelta: bigint;
      counterAccountId: string;
    },
  ): Promise<{ ledgerTx: LedgerTransaction; balance: bigint }> {
    const ledgerTx = await tx.ledgerTransaction.create({
      data: {
        type: p.type,
        currency: p.req.currency,
        source: p.source,
        playerId: p.req.playerId,
        externalTxId: p.req.txId,
        gameId: p.req.gameId,
        roundId: p.req.roundId,
        amount: p.amount,
        originalExternalTxId: p.originalExternalTxId ?? null,
      },
    });

    if (p.playerDelta === 0n) return { ledgerTx, balance: p.player.balance };

    const updated = await tx.$queryRaw<{ balance: bigint }[]>`
      UPDATE platform.accounts SET balance = balance + ${p.playerDelta}
      WHERE id = ${p.player.id}::uuid RETURNING balance`;
    const balance = updated[0]!.balance;

    await tx.ledgerEntry.createMany({
      data: [
        { transactionId: ledgerTx.id, accountId: p.player.id, amount: p.playerDelta, balanceAfter: balance },
        { transactionId: ledgerTx.id, accountId: p.counterAccountId, amount: -p.playerDelta },
      ],
    });
    return { ledgerTx, balance };
  }
}

// ───────────────────────── helpers ─────────────────────────

function validateId(name: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw new WalletError("INVALID_REQUEST", `${name} must be a non-empty string of at most ${MAX_ID_LENGTH} chars`);
  }
}

function validateTx(req: { txId: string; gameId: string; roundId: string; currency: string }): void {
  validateId("txId", req.txId);
  validateId("gameId", req.gameId);
  validateId("roundId", req.roundId);
  if (req.currency !== "ETB" && req.currency !== "DEMO") throw new WalletError("INVALID_REQUEST", "unknown currency");
}

function findTx(tx: Tx, source: string, playerId: string, externalTxId: string) {
  return tx.ledgerTransaction.findUnique({
    where: { source_playerId_externalTxId: { source, playerId, externalTxId } },
  });
}

function sameGameTx(t: LedgerTransaction, req: DebitRequest | CreditRequest): boolean {
  return t.amount === req.amount && t.currency === req.currency && t.gameId === req.gameId && t.roundId === req.roundId;
}

function result(req: { txId: string; playerId: string; currency: Currency }, walletTxId: string, balance: bigint, duplicate: boolean): TxResult {
  return { txId: req.txId, walletTxId, playerId: req.playerId, currency: req.currency, balance, duplicate };
}

function dup(req: { txId: string; playerId: string; currency: Currency }, t: LedgerTransaction, balance: bigint): TxResult {
  return result(req, t.id, balance, true);
}
