/** BingoStore backed by the `games` schema. */
import type { Db } from "@kokeb/db";
import type { BingoCardRecord, BingoGameRecord, BingoStore, BingoWinner } from "@kokeb/games";
import type { Currency } from "@kokeb/wallet-contract";

type GameRow = Awaited<ReturnType<Db["bingoGame"]["findFirstOrThrow"]>>;
type CardRow = Awaited<ReturnType<Db["bingoCard"]["findFirstOrThrow"]>>;

export class PrismaBingoStore implements BingoStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async openGames() {
    const rows = await this.db.bingoGame.findMany({ where: { status: { in: ["LOBBY", "COUNTDOWN", "DRAWING"] } } });
    return rows.map(toGame);
  }

  async saveGame(g: BingoGameRecord) {
    const data = {
      status: g.status,
      countdownEndsAt: g.countdownEndsAt,
      startedAt: g.startedAt,
      finishedAt: g.finishedAt,
      calls: g.calls,
      pot: g.pot,
      commission: g.commission,
      prize: g.prize,
      winners: g.winners.map((w) => ({ ...w, payout: w.payout.toString() })),
    };
    await this.db.bingoGame.upsert({
      where: { id: g.id },
      create: { id: g.id, roomId: g.roomId, seed: g.seed, seedHash: g.seedHash, createdAt: g.createdAt, ...data },
      update: data,
    });
  }

  async saveCard(c: BingoCardRecord) {
    const data = { status: c.status, payout: c.payout, settled: c.settled };
    await this.db.bingoCard.upsert({
      where: { id: c.id },
      create: {
        id: c.id,
        gameId: c.gameId,
        roomId: c.roomId,
        playerId: c.playerId,
        label: c.label,
        cardNumber: c.cardNumber,
        currency: c.currency,
        stake: c.stake,
        createdAt: c.createdAt,
        ...data,
      },
      update: data,
    });
  }

  async cardsForGame(gameId: string) {
    return (await this.db.bingoCard.findMany({ where: { gameId } })).map(toCard);
  }

  async unsettledCards() {
    return (await this.db.bingoCard.findMany({ where: { settled: false, status: { not: "REJECTED" } } })).map(toCard);
  }

  async recentGames(roomId: string, limit: number) {
    return (await this.db.bingoGame.findMany({ where: { roomId }, orderBy: { createdAt: "desc" }, take: limit })).map(toGame);
  }
}

function toGame(g: GameRow): BingoGameRecord {
  const winners = (g.winners as unknown as (Omit<BingoWinner, "payout"> & { payout: string })[]).map((w) => ({ ...w, payout: BigInt(w.payout) }));
  return {
    id: g.id,
    roomId: g.roomId,
    seed: g.seed,
    seedHash: g.seedHash,
    status: g.status,
    createdAt: g.createdAt,
    countdownEndsAt: g.countdownEndsAt,
    startedAt: g.startedAt,
    finishedAt: g.finishedAt,
    calls: g.calls,
    pot: g.pot,
    commission: g.commission,
    prize: g.prize,
    winners,
  };
}

function toCard(c: CardRow): BingoCardRecord {
  return {
    id: c.id,
    gameId: c.gameId,
    roomId: c.roomId,
    playerId: c.playerId,
    label: c.label,
    cardNumber: c.cardNumber,
    currency: c.currency as Currency,
    stake: c.stake,
    status: c.status,
    payout: c.payout,
    settled: c.settled,
    createdAt: c.createdAt,
  };
}
