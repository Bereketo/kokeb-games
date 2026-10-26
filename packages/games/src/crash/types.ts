import type { Currency } from "@kokeb/wallet-contract";

export type RoundStatus = "BETTING" | "FLYING" | "CRASHED" | "VOID";

/**
 * Bet lifecycle:
 *   PENDING ──debit ok──▶ PLACED ──cashout──▶ CASHED_OUT ──credit(payout)──▶ settled
 *      │                     │
 *      │                     ├──round crashes──▶ LOST ──credit(0)──▶ settled
 *      │                     └──player cancels / round void──▶ CANCELLED ──rollback──▶ settled
 *      ├──debit refused (no funds...)──▶ REJECTED (nothing to settle)
 *      └──debit unclear or too late──▶ CANCELLED ──rollback──▶ settled
 */
export type BetStatus = "PENDING" | "PLACED" | "CASHED_OUT" | "LOST" | "CANCELLED" | "REJECTED";

export interface RoundRecord {
  id: string;
  /** Position in the hash chain (1-based). */
  number: number;
  hash: string;
  /** Hundredths: 235 = 2.35x. Secret until the round crashes. */
  crashPoint: number;
  status: RoundStatus;
  bettingStartedAt: Date;
  flyingStartedAt: Date | null;
  crashedAt: Date | null;
}

export interface BetRecord {
  id: string;
  roundId: string;
  playerId: string;
  /** Public, masked name shown in the live bets list, e.g. "25***59". */
  label: string;
  /** Each player has two bet panels: 0 and 1. */
  slot: number;
  currency: Currency;
  amount: bigint;
  /** Hundredths, or null for manual cash-out only. */
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: bigint | null;
  /** True once the wallet acknowledged the final credit or rollback. */
  settled: boolean;
  createdAt: Date;
}

/** Where the engine keeps its records. Prisma in production, memory in tests. */
export interface CrashStore {
  lastRound(): Promise<RoundRecord | null>;
  recentRounds(limit: number): Promise<RoundRecord[]>;
  saveRound(round: RoundRecord): Promise<void>;
  saveBet(bet: BetRecord): Promise<void>;
  betsForRound(roundId: string): Promise<BetRecord[]>;
  /** Bets whose wallet settlement hasn't been acknowledged yet. */
  unsettledBets(): Promise<BetRecord[]>;
}

export interface CrashConfig {
  /** Game id sent to the wallet and used in the catalog. */
  gameId: string;
  /** House edge in basis points: 300 = 3%. */
  houseEdgeBps: number;
  /** Public salt fixed after the chain commitment was published. */
  salt: string;
  bettingMs: number;
  /** Pause after a crash before the next betting phase. */
  cooldownMs: number;
  /** Minor units (santim). Same limits apply to DEMO. */
  minBet: bigint;
  maxBet: bigint;
  /** Largest payout one bet can win; the bet is cashed out automatically there. */
  maxPayout: bigint;
}

export const DEFAULT_CRASH_CONFIG: CrashConfig = {
  gameId: "crash",
  houseEdgeBps: 300,
  salt: "",
  bettingMs: 6_000,
  cooldownMs: 3_000,
  minBet: 100n, // 1 ETB
  maxBet: 1_000_000n, // 10,000 ETB
  maxPayout: 100_000_000n, // 1,000,000 ETB
};

/** What the public sees about a bet. */
export interface PublicBet {
  label: string;
  slot: number;
  currency: Currency;
  amount: string;
  autoCashout: number | null;
  status: BetStatus;
  cashoutMultiplier: number | null;
  payout: string | null;
}

export interface PublicRound {
  id: string;
  number: number;
  status: RoundStatus;
  bettingEndsAt: number;
  flyingStartedAt: number | null;
  /** Only once crashed. */
  crashPoint: number | null;
  /** Only once crashed (it reveals the result). */
  hash: string | null;
}

export type CrashEvent =
  | { type: "round:betting"; round: PublicRound }
  | { type: "round:flying"; round: PublicRound; serverTime: number }
  | { type: "round:crashed"; round: PublicRound }
  // playerId is for the server to route "this is yours" to the owner; never broadcast it.
  | { type: "bet:placed"; roundId: string; playerId: string; bet: PublicBet }
  | { type: "bet:cancelled"; roundId: string; playerId: string; bet: PublicBet }
  | { type: "bet:cashed"; roundId: string; playerId: string; bet: PublicBet }
  | { type: "balance"; playerId: string; currency: Currency; balance: string }
  | { type: "settlement:failed"; betId: string; reason: string };

export type GameErrorCode =
  | "BETTING_CLOSED"
  | "INVALID_BET"
  | "SLOT_TAKEN"
  | "NO_ACTIVE_BET"
  | "TOO_LATE"
  | "INSUFFICIENT_FUNDS"
  | "PLAYER_BLOCKED"
  | "WALLET_UNAVAILABLE";

export class GameError extends Error {
  readonly code: GameErrorCode;
  constructor(code: GameErrorCode, message?: string) {
    super(message ?? code);
    this.name = "GameError";
    this.code = code;
  }
}
