/**
 * The Kokeb wallet contract.
 *
 * Every game, our own or a third-party provider's, moves money ONLY through
 * these four operations. Games never hold balances and never see anything
 * about the player except an opaque `playerId`.
 *
 * Money is always an integer number of MINOR units (santim for ETB:
 * 1 ETB = 100 santim) carried as `bigint`. Never use floating point for money.
 */

/** Real money currencies plus the play-money currency used by "Try Demo". */
export type Currency = "ETB" | "DEMO";

export const CURRENCIES: readonly Currency[] = ["ETB", "DEMO"] as const;

/**
 * How a game session is played. A `demo` session simply uses the DEMO currency:
 * the game code is identical, only the currency differs.
 */
export type SessionMode = "real" | "demo";

export function currencyForMode(mode: SessionMode, realCurrency: Currency = "ETB"): Currency {
  return mode === "demo" ? "DEMO" : realCurrency;
}

export interface BalanceRequest {
  playerId: string;
  currency: Currency;
}

interface TxBase {
  /**
   * The game's own id for this transaction. Unique per (provider, player).
   * Retrying with the same txId is always safe: the wallet returns the stored
   * result instead of moving money twice.
   */
  txId: string;
  playerId: string;
  currency: Currency;
  gameId: string;
  roundId: string;
}

/** Take a stake from the player (a bet, a bingo ticket purchase). */
export interface DebitRequest extends TxBase {
  /** Minor units, must be > 0. */
  amount: bigint;
}

/**
 * Pay the player for a round. `amount` may be 0 (a loss), which still closes
 * the round on the wallet side. A credit is only accepted for a round that
 * has at least one live (not rolled back) debit from the same player.
 */
export interface CreditRequest extends TxBase {
  /** Minor units, must be >= 0. */
  amount: bigint;
}

/**
 * Reverse a DEBIT as if it never happened (the game failed after taking the
 * stake). Credits are never rolled back: a game must retry a credit until it
 * is acknowledged.
 *
 * If the original debit is unknown (e.g. it timed out and never arrived), the
 * wallet records the rollback anyway, so that a late-arriving debit with that
 * id is rejected with TX_ALREADY_ROLLED_BACK.
 */
export interface RollbackRequest {
  txId: string;
  playerId: string;
  currency: Currency;
  gameId: string;
  roundId: string;
  /** The txId of the debit being reversed. */
  originalTxId: string;
}

export interface BalanceResult {
  playerId: string;
  currency: Currency;
  /** Minor units. */
  balance: bigint;
}

export interface TxResult extends BalanceResult {
  txId: string;
  /** The wallet's own id for the recorded transaction. */
  walletTxId: string;
  /** true when this request repeated an already-processed txId. */
  duplicate: boolean;
}

export interface WalletPort {
  balance(req: BalanceRequest): Promise<BalanceResult>;
  debit(req: DebitRequest): Promise<TxResult>;
  credit(req: CreditRequest): Promise<TxResult>;
  rollback(req: RollbackRequest): Promise<TxResult>;
}
