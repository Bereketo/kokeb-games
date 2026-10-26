/**
 * MemoryWallet: an in-memory WalletPort for tests and local experiments.
 *
 * It follows exactly the same rules as the real ledger and must pass the same
 * conformance suite. Every operation runs synchronously between its checks
 * and its writes, so concurrent calls can't interleave (JS is single-threaded).
 *
 * Extra test hooks: `failNext(op, times)` makes the next calls throw a
 * retryable INTERNAL error, to test how games handle an unreachable wallet.
 */
import { WalletError } from "./errors.ts";
import type {
  BalanceRequest,
  BalanceResult,
  CreditRequest,
  Currency,
  DebitRequest,
  RollbackRequest,
  TxResult,
  WalletPort,
} from "./types.ts";

type Kind = "BET" | "WIN" | "ROLLBACK";

interface Tx {
  walletTxId: string;
  kind: Kind;
  playerId: string;
  currency: Currency;
  amount: bigint;
  gameId: string;
  roundId: string;
  originalTxId?: string;
  rolledBack?: boolean;
}

type Op = "debit" | "credit" | "rollback" | "balance";

export class MemoryWallet implements WalletPort {
  readonly demoGrant: bigint;
  private readonly balances = new Map<string, bigint>(); // `${player}:${currency}`
  private readonly players = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly txs = new Map<string, Tx>(); // `${player}:${txId}`
  private readonly failures = new Map<Op, number>();
  private seq = 0;
  /** Every successful call, in order, for assertions. */
  readonly log: { op: Op; txId?: string; amount?: bigint; duplicate?: boolean }[] = [];

  constructor(opts: { demoGrant?: bigint } = {}) {
    this.demoGrant = opts.demoGrant ?? 1_000_000n;
  }

  // ── test helpers ──
  addPlayer(playerId: string, etb = 0n): void {
    this.players.add(playerId);
    this.balances.set(`${playerId}:ETB`, etb);
    this.balances.set(`${playerId}:DEMO`, this.demoGrant);
  }
  setBlocked(playerId: string, blocked = true): void {
    if (blocked) this.blocked.add(playerId);
    else this.blocked.delete(playerId);
  }
  failNext(op: Op, times = 1): void {
    this.failures.set(op, times);
  }
  peek(playerId: string, currency: Currency = "ETB"): bigint {
    return this.balances.get(`${playerId}:${currency}`) ?? 0n;
  }

  // ── WalletPort ──
  async balance(req: BalanceRequest): Promise<BalanceResult> {
    await Promise.resolve();
    this.maybeFail("balance");
    this.requirePlayer(req.playerId);
    this.log.push({ op: "balance" });
    return { playerId: req.playerId, currency: req.currency, balance: this.peek(req.playerId, req.currency) };
  }

  async debit(req: DebitRequest): Promise<TxResult> {
    await Promise.resolve();
    this.maybeFail("debit");
    validate(req);
    if (req.amount <= 0n) throw new WalletError("INVALID_REQUEST", "debit amount must be > 0");
    this.requirePlayer(req.playerId);

    const existing = this.txs.get(key(req.playerId, req.txId));
    if (existing) {
      if (existing.kind === "BET" && same(existing, req)) return this.dup(req, existing);
      throw new WalletError("TX_CONFLICT");
    }
    if (this.findRollbackOf(req.playerId, req.txId)) throw new WalletError("TX_ALREADY_ROLLED_BACK");
    if (this.blocked.has(req.playerId)) throw new WalletError("PLAYER_BLOCKED");
    if (this.peek(req.playerId, req.currency) < req.amount) throw new WalletError("INSUFFICIENT_FUNDS");

    return this.record(req, "BET", req.amount, -req.amount, "debit");
  }

  async credit(req: CreditRequest): Promise<TxResult> {
    await Promise.resolve();
    this.maybeFail("credit");
    validate(req);
    if (req.amount < 0n) throw new WalletError("INVALID_REQUEST", "credit amount must be >= 0");
    this.requirePlayer(req.playerId);

    const existing = this.txs.get(key(req.playerId, req.txId));
    if (existing) {
      if (existing.kind === "WIN" && same(existing, req)) return this.dup(req, existing);
      throw new WalletError("TX_CONFLICT");
    }
    const liveBet = [...this.txs.values()].some(
      (t) => t.playerId === req.playerId && t.kind === "BET" && t.roundId === req.roundId && t.currency === req.currency && !t.rolledBack,
    );
    if (!liveBet) throw new WalletError("ROUND_NOT_FOUND");

    return this.record(req, "WIN", req.amount, req.amount, "credit");
  }

  async rollback(req: RollbackRequest): Promise<TxResult> {
    await Promise.resolve();
    this.maybeFail("rollback");
    validate(req);
    if (!req.originalTxId) throw new WalletError("INVALID_REQUEST", "originalTxId is required");
    this.requirePlayer(req.playerId);

    const existing = this.txs.get(key(req.playerId, req.txId));
    if (existing) {
      if (existing.kind === "ROLLBACK" && existing.originalTxId === req.originalTxId) return this.dup(req, existing);
      throw new WalletError("TX_CONFLICT");
    }
    const original = this.txs.get(key(req.playerId, req.originalTxId));
    const prior = this.findRollbackOf(req.playerId, req.originalTxId);

    if (original) {
      if (original.kind !== "BET") throw new WalletError("ROLLBACK_NOT_ALLOWED");
      if (original.currency !== req.currency) throw new WalletError("INVALID_REQUEST", "currency mismatch");
      if (original.rolledBack && prior) return this.dup(req, prior);
      original.rolledBack = true;
      return this.record(req, "ROLLBACK", original.amount, original.amount, "rollback", req.originalTxId);
    }
    if (prior) return this.dup(req, prior);
    return this.record(req, "ROLLBACK", 0n, 0n, "rollback", req.originalTxId);
  }

  // ── internals ──
  private record(
    req: { txId: string; playerId: string; currency: Currency; gameId: string; roundId: string },
    kind: Kind,
    amount: bigint,
    delta: bigint,
    op: Op,
    originalTxId?: string,
  ): TxResult {
    const tx: Tx = {
      walletTxId: `mem-${++this.seq}`,
      kind,
      playerId: req.playerId,
      currency: req.currency,
      amount,
      gameId: req.gameId,
      roundId: req.roundId,
      ...(originalTxId ? { originalTxId } : {}),
    };
    this.txs.set(key(req.playerId, req.txId), tx);
    const bal = this.peek(req.playerId, req.currency) + delta;
    this.balances.set(`${req.playerId}:${req.currency}`, bal);
    this.log.push({ op, txId: req.txId, amount, duplicate: false });
    return { txId: req.txId, walletTxId: tx.walletTxId, playerId: req.playerId, currency: req.currency, balance: bal, duplicate: false };
  }

  private dup(req: { txId: string; playerId: string; currency: Currency }, tx: Tx): TxResult {
    this.log.push({ op: tx.kind === "BET" ? "debit" : tx.kind === "WIN" ? "credit" : "rollback", txId: req.txId, duplicate: true });
    return {
      txId: req.txId,
      walletTxId: tx.walletTxId,
      playerId: req.playerId,
      currency: req.currency,
      balance: this.peek(req.playerId, req.currency),
      duplicate: true,
    };
  }

  private findRollbackOf(playerId: string, originalTxId: string): Tx | undefined {
    for (const t of this.txs.values()) {
      if (t.playerId === playerId && t.kind === "ROLLBACK" && t.originalTxId === originalTxId) return t;
    }
    return undefined;
  }

  private requirePlayer(playerId: string): void {
    if (!this.players.has(playerId)) throw new WalletError("PLAYER_NOT_FOUND");
  }

  private maybeFail(op: Op): void {
    const n = this.failures.get(op) ?? 0;
    if (n > 0) {
      this.failures.set(op, n - 1);
      throw new WalletError("INTERNAL", `simulated ${op} failure`);
    }
  }
}

function key(playerId: string, txId: string): string {
  return `${playerId}:${txId}`;
}

function same(t: Tx, req: { amount: bigint; currency: Currency; gameId: string; roundId: string }): boolean {
  return t.amount === req.amount && t.currency === req.currency && t.gameId === req.gameId && t.roundId === req.roundId;
}

function validate(req: { txId: string; gameId: string; roundId: string; currency: string }): void {
  for (const [name, v] of [["txId", req.txId], ["gameId", req.gameId], ["roundId", req.roundId]] as const) {
    if (typeof v !== "string" || v.length === 0 || v.length > 128) throw new WalletError("INVALID_REQUEST", `bad ${name}`);
  }
  if (req.currency !== "ETB" && req.currency !== "DEMO") throw new WalletError("INVALID_REQUEST", "unknown currency");
}
