/**
 * InProcessWallet: the WalletPort our own games use when they run inside the
 * platform process. Calls the ledger directly, no HTTP. Swapping it for an
 * HttpWallet is a config change; the games don't notice.
 */
import {
  WalletError,
  type BalanceRequest,
  type BalanceResult,
  type CreditRequest,
  type DebitRequest,
  type RollbackRequest,
  type TxResult,
  type WalletPort,
} from "@kokeb/wallet-contract";
import type { Ledger } from "./ledger.ts";

export const KOKEB_PROVIDER_ID = "kokeb";

export interface InProcessWalletOptions {
  /** Provider id the calling games belong to. Default "kokeb" (our own games). */
  providerId?: string;
  /** Called for unexpected errors before they are turned into INTERNAL. */
  onUnexpectedError?: (err: unknown) => void;
}

export class InProcessWallet implements WalletPort {
  private readonly ledger: Ledger;
  private readonly providerId: string;
  private readonly onUnexpectedError: (err: unknown) => void;

  constructor(ledger: Ledger, opts: InProcessWalletOptions = {}) {
    this.ledger = ledger;
    this.providerId = opts.providerId ?? KOKEB_PROVIDER_ID;
    this.onUnexpectedError = opts.onUnexpectedError ?? ((err) => console.error("[wallet] unexpected error", err));
  }

  balance(req: BalanceRequest): Promise<BalanceResult> {
    return this.guard(async () => ({
      playerId: req.playerId,
      currency: req.currency,
      balance: await this.ledger.balance(req.playerId, req.currency),
    }));
  }

  debit(req: DebitRequest): Promise<TxResult> {
    return this.guard(() => this.ledger.debit(this.providerId, req));
  }

  credit(req: CreditRequest): Promise<TxResult> {
    return this.guard(() => this.ledger.credit(this.providerId, req));
  }

  rollback(req: RollbackRequest): Promise<TxResult> {
    return this.guard(() => this.ledger.rollback(this.providerId, req));
  }

  /** Games only ever see WalletErrors; anything else becomes a retryable INTERNAL. */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof WalletError) throw err;
      this.onUnexpectedError(err);
      throw new WalletError("INTERNAL", "wallet temporarily unavailable, retry with the same txId");
    }
  }
}
