/**
 * Settlement queue: makes sure every bet's final wallet call (credit the
 * payout, credit 0 for a loss, or roll back the stake) eventually succeeds.
 *
 * Retryable failures (wallet down, timeout) are retried with backoff using
 * the SAME txId, forever: the wallet's idempotency makes that safe. Final
 * (non-retryable) errors are reported for manual review instead of looping.
 */
import { WalletError, type WalletPort } from "@kokeb/wallet-contract";
import type { BetRecord } from "./types.ts";

export function betTxIds(bet: Pick<BetRecord, "roundId" | "slot">) {
  const base = `${bet.roundId}:${bet.slot}`;
  return { bet: `${base}:bet`, win: `${base}:win`, rollback: `${base}:rb` };
}

export interface SettlementDeps {
  wallet: WalletPort;
  gameId: string;
  /** Persist the bet once settled. */
  onSettled: (bet: BetRecord, balance: bigint) => Promise<void> | void;
  onFailed: (bet: BetRecord, reason: string) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export class SettlementQueue {
  private readonly deps: SettlementDeps;
  private readonly inFlight = new Set<string>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(deps: SettlementDeps) {
    this.deps = deps;
  }

  get pending(): number {
    return this.inFlight.size;
  }

  enqueue(bet: BetRecord): void {
    if (bet.settled || bet.status === "REJECTED" || this.inFlight.has(bet.id)) return;
    this.inFlight.add(bet.id);
    void this.attempt(bet, 0);
  }

  /** Resolves once nothing is in flight (used by tests and graceful shutdown). */
  async drain(timeoutMs = 10_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (this.inFlight.size > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 5));
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private async attempt(bet: BetRecord, tries: number): Promise<void> {
    if (this.stopped) return;
    try {
      const balance = await this.call(bet);
      bet.settled = true;
      await this.deps.onSettled(bet, balance);
      this.inFlight.delete(bet.id);
    } catch (err) {
      if (err instanceof WalletError && !err.retryable) {
        this.inFlight.delete(bet.id);
        this.deps.onFailed(bet, `${err.code}: ${err.message}`);
        return;
      }
      const base = this.deps.baseDelayMs ?? 500;
      const delay = Math.min(base * 2 ** tries, this.deps.maxDelayMs ?? 30_000);
      const t = setTimeout(() => {
        this.timers.delete(t);
        void this.attempt(bet, tries + 1);
      }, delay);
      this.timers.add(t);
    }
  }

  private async call(bet: BetRecord): Promise<bigint> {
    const ids = betTxIds(bet);
    const common = { playerId: bet.playerId, currency: bet.currency, gameId: this.deps.gameId, roundId: bet.roundId };
    switch (bet.status) {
      case "CASHED_OUT":
        return (await this.deps.wallet.credit({ ...common, txId: ids.win, amount: bet.payout ?? 0n })).balance;
      case "LOST":
        return (await this.deps.wallet.credit({ ...common, txId: ids.win, amount: 0n })).balance;
      case "CANCELLED":
      case "PENDING":
        return (await this.deps.wallet.rollback({ ...common, txId: ids.rollback, originalTxId: ids.bet })).balance;
      default:
        throw new Error(`bet ${bet.id} in status ${bet.status} has nothing to settle`);
    }
  }
}
