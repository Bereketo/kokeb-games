/**
 * Every failure a wallet can report. The HTTP wallet maps these 1:1 to the
 * `code` field of an error response, so games handle them the same way
 * whether the wallet is in-process or remote.
 *
 * `retryable` tells the game what to do:
 *  - false: a final answer. Do not retry the same request.
 *  - true:  the wallet could not decide (timeout, outage). Retry with the
 *           SAME txId; for a debit you may instead send a rollback.
 */
export const WALLET_ERROR_CODES = {
  INSUFFICIENT_FUNDS: { status: 402, retryable: false },
  PLAYER_NOT_FOUND: { status: 404, retryable: false },
  INVALID_REQUEST: { status: 400, retryable: false },
  /** Same txId was already used with a different payload. */
  TX_CONFLICT: { status: 409, retryable: false },
  /** A debit arrived after it had already been rolled back. */
  TX_ALREADY_ROLLED_BACK: { status: 409, retryable: false },
  /** Credit for a round with no live debit from this player. */
  ROUND_NOT_FOUND: { status: 404, retryable: false },
  /** Rollback targets something that is not a debit (e.g. a credit). */
  ROLLBACK_NOT_ALLOWED: { status: 409, retryable: false },
  /** Player is blocked, self-excluded, or over a limit. */
  PLAYER_BLOCKED: { status: 403, retryable: false },
  /** Bad or missing signature / unknown provider (HTTP only). */
  UNAUTHORIZED: { status: 401, retryable: false },
  /** Anything unexpected. Safe to retry with the same txId. */
  INTERNAL: { status: 500, retryable: true },
} as const;

export type WalletErrorCode = keyof typeof WALLET_ERROR_CODES;

export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: WalletErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WalletError";
    this.code = code;
    this.status = WALLET_ERROR_CODES[code].status;
    this.retryable = WALLET_ERROR_CODES[code].retryable;
  }
}

export function isWalletError(err: unknown, code?: WalletErrorCode): err is WalletError {
  return err instanceof WalletError && (code === undefined || err.code === code);
}
