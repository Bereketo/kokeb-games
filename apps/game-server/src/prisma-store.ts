/**
 * CrashStore backed by the `games` schema. Rounds are scoped to one hash
 * chain (by its commitment), so rotating to a new chain starts at game 1
 * without clashing with old rounds.
 */
import type { Db } from "@kokeb/db";
import type { BetRecord, CrashStore, RoundRecord } from "@kokeb/games";
import type { Currency } from "@kokeb/wallet-contract";

type RoundRow = Awaited<ReturnType<Db["crashRound"]["findFirstOrThrow"]>>;
type BetRow = Awaited<ReturnType<Db["crashBet"]["findFirstOrThrow"]>>;

export class PrismaCrashStore implements CrashStore {
  private readonly db: Db;
  private readonly chain: string;

  constructor(db: Db, chainCommitment: string) {
    this.db = db;
    this.chain = chainCommitment;
  }

  async lastRound(): Promise<RoundRecord | null> {
    const r = await this.db.crashRound.findFirst({ where: { chain: this.chain }, orderBy: { number: "desc" } });
    return r ? toRound(r) : null;
  }

  async recentRounds(limit: number): Promise<RoundRecord[]> {
    const rows = await this.db.crashRound.findMany({ where: { chain: this.chain }, orderBy: { number: "desc" }, take: limit });
    return rows.map(toRound);
  }

  async saveRound(r: RoundRecord): Promise<void> {
    const data = {
      number: r.number,
      hash: r.hash,
      crashPoint: r.crashPoint,
      status: r.status,
      bettingStartedAt: r.bettingStartedAt,
      flyingStartedAt: r.flyingStartedAt,
      crashedAt: r.crashedAt,
    };
    await this.db.crashRound.upsert({ where: { id: r.id }, create: { id: r.id, chain: this.chain, ...data }, update: data });
  }

  async saveBet(b: BetRecord): Promise<void> {
    const data = {
      status: b.status,
      cashoutMultiplier: b.cashoutMultiplier,
      payout: b.payout,
      settled: b.settled,
    };
    await this.db.crashBet.upsert({
      where: { id: b.id },
      create: {
        id: b.id,
        roundId: b.roundId,
        playerId: b.playerId,
        label: b.label,
        slot: b.slot,
        currency: b.currency,
        amount: b.amount,
        autoCashout: b.autoCashout,
        createdAt: b.createdAt,
        ...data,
      },
      update: data,
    });
  }

  async betsForRound(roundId: string): Promise<BetRecord[]> {
    return (await this.db.crashBet.findMany({ where: { roundId } })).map(toBet);
  }

  async unsettledBets(): Promise<BetRecord[]> {
    const rows = await this.db.crashBet.findMany({ where: { settled: false, status: { not: "REJECTED" } } });
    return rows.map(toBet);
  }
}

function toRound(r: RoundRow): RoundRecord {
  return {
    id: r.id,
    number: r.number,
    hash: r.hash,
    crashPoint: r.crashPoint,
    status: r.status,
    bettingStartedAt: r.bettingStartedAt,
    flyingStartedAt: r.flyingStartedAt,
    crashedAt: r.crashedAt,
  };
}

function toBet(b: BetRow): BetRecord {
  return {
    id: b.id,
    roundId: b.roundId,
    playerId: b.playerId,
    label: b.label,
    slot: b.slot,
    currency: b.currency as Currency,
    amount: b.amount,
    autoCashout: b.autoCashout,
    status: b.status,
    cashoutMultiplier: b.cashoutMultiplier,
    payout: b.payout,
    settled: b.settled,
    createdAt: b.createdAt,
  };
}
