import type { Currency } from "@kokeb/wallet-contract";

export interface BingoRoomConfig {
  id: string;
  name: string;
  currency: Currency;
  /** Price of one cartela, minor units. */
  stake: bigint;
}

export interface BingoConfig {
  /** Game id sent to the wallet. */
  gameId: string;
  rooms: BingoRoomConfig[];
  /** Public seed that fixes every cartela's numbers. Never change it once players know the cards. */
  deckSeed: string;
  /** Cartelas 1..cardsPerRoom can be picked. */
  cardsPerRoom: number;
  maxCardsPerPlayer: number;
  /** Distinct players needed before the countdown starts. */
  minPlayers: number;
  countdownMs: number;
  drawIntervalMs: number;
  /** After the first valid BINGO, others have this long to claim and share. */
  claimWindowMs: number;
  /** An unclaimed winning card is claimed automatically after this many more balls. */
  autoClaimAfterCalls: number;
  /** House cut of the pot, basis points: 2000 = 20%. */
  commissionBps: number;
  /** Results stay on screen this long before the next game opens. */
  resultsMs: number;
}

export const DEFAULT_BINGO_CONFIG: Omit<BingoConfig, "deckSeed"> = {
  gameId: "bingo75",
  rooms: [
    { id: "demo-10", name: "Practice", currency: "DEMO", stake: 1_000n },
    { id: "etb-10", name: "10 Birr", currency: "ETB", stake: 1_000n },
    { id: "etb-20", name: "20 Birr", currency: "ETB", stake: 2_000n },
    { id: "etb-50", name: "50 Birr", currency: "ETB", stake: 5_000n },
    { id: "etb-100", name: "100 Birr", currency: "ETB", stake: 10_000n },
  ],
  cardsPerRoom: 100,
  maxCardsPerPlayer: 2,
  minPlayers: 2,
  countdownMs: 30_000,
  drawIntervalMs: 3_000,
  claimWindowMs: 5_000,
  autoClaimAfterCalls: 3,
  commissionBps: 2_000,
  resultsMs: 8_000,
};

export type BingoGameStatus = "LOBBY" | "COUNTDOWN" | "DRAWING" | "FINISHED" | "VOID";

/**
 * Cartela lifecycle:
 *   PENDING ─debit ok─▶ HELD ─▶ WON (credit payout) | LOST (credit 0) | ELIMINATED, false BINGO (credit 0)
 *      │                 └─returned before the draw / game void──▶ CANCELLED (rollback = refund)
 *      ├─debit refused──▶ REJECTED (nothing to settle)
 *      └─debit unclear or too late──▶ CANCELLED (rollback)
 */
export type BingoCardStatus = "PENDING" | "HELD" | "WON" | "LOST" | "ELIMINATED" | "CANCELLED" | "REJECTED";

export interface BingoWinner {
  cardNumber: number;
  playerId: string;
  label: string;
  pattern: string;
  /** Card indexes that form the pattern (for highlighting). */
  cells: number[];
  payout: bigint;
  auto: boolean;
}

export interface BingoGameRecord {
  id: string;
  roomId: string;
  /** Secret until the game ends. */
  seed: string;
  seedHash: string;
  status: BingoGameStatus;
  createdAt: Date;
  countdownEndsAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** How many balls of the draw order have been called. */
  calls: number;
  /** Fixed when the draw starts. */
  pot: bigint;
  commission: bigint;
  prize: bigint;
  winners: BingoWinner[];
}

export interface BingoCardRecord {
  id: string;
  gameId: string;
  roomId: string;
  playerId: string;
  label: string;
  cardNumber: number;
  currency: Currency;
  stake: bigint;
  status: BingoCardStatus;
  payout: bigint | null;
  settled: boolean;
  createdAt: Date;
}

export interface BingoStore {
  /** Games that never reached FINISHED/VOID (after a restart). */
  openGames(): Promise<BingoGameRecord[]>;
  saveGame(game: BingoGameRecord): Promise<void>;
  saveCard(card: BingoCardRecord): Promise<void>;
  cardsForGame(gameId: string): Promise<BingoCardRecord[]>;
  unsettledCards(): Promise<BingoCardRecord[]>;
  recentGames(roomId: string, limit: number): Promise<BingoGameRecord[]>;
}

export interface PublicBingoWinner {
  cardNumber: number;
  label: string;
  pattern: string;
  cells: number[];
  payout: string;
  auto: boolean;
}

export interface PublicBingoRoom {
  roomId: string;
  name: string;
  currency: Currency;
  stake: string;
  gameId: string;
  status: BingoGameStatus;
  seedHash: string;
  countdownEndsAt: number | null;
  claimWindowEndsAt: number | null;
  nextCallAt: number | null;
  /** Cartela numbers already taken this game. */
  taken: number[];
  players: number;
  /** Prize if the draw started now (stake × cards − cut). */
  prize: string;
  called: number[];
  winners: PublicBingoWinner[];
  /** Revealed once finished. */
  seed: string | null;
}

export type BingoEvent =
  | { type: "bingo:room"; room: PublicBingoRoom }
  | { type: "bingo:ball"; roomId: string; gameId: string; ball: number; index: number }
  | { type: "bingo:claim"; roomId: string; gameId: string; cardNumber: number; label: string; valid: boolean; auto: boolean }
  | { type: "bingo:card"; roomId: string; gameId: string; playerId: string; cardNumber: number; status: BingoCardStatus; payout: string | null }
  | { type: "balance"; playerId: string; currency: Currency; balance: string }
  | { type: "settlement:failed"; cardId: string; reason: string };

export type BingoErrorCode =
  | "ROOM_NOT_FOUND"
  | "PICKING_CLOSED"
  | "INVALID_CARD"
  | "CARD_TAKEN"
  | "CARD_LIMIT"
  | "NOT_YOUR_CARD"
  | "NOT_DRAWING"
  | "INSUFFICIENT_FUNDS"
  | "PLAYER_BLOCKED"
  | "WALLET_UNAVAILABLE";

export class BingoError extends Error {
  readonly code: BingoErrorCode;
  constructor(code: BingoErrorCode, message?: string) {
    super(message ?? code);
    this.name = "BingoError";
    this.code = code;
  }
}
