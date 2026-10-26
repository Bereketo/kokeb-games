import type { BetRecord, CrashStore, RoundRecord } from "./types.ts";

/** In-memory CrashStore for tests and local experiments. */
export class MemoryCrashStore implements CrashStore {
  readonly rounds = new Map<string, RoundRecord>();
  readonly bets = new Map<string, BetRecord>();

  async lastRound(): Promise<RoundRecord | null> {
    let last: RoundRecord | null = null;
    for (const r of this.rounds.values()) if (!last || r.number > last.number) last = r;
    return last ? { ...last } : null;
  }
  async recentRounds(limit: number): Promise<RoundRecord[]> {
    return [...this.rounds.values()].sort((a, b) => b.number - a.number).slice(0, limit).map((r) => ({ ...r }));
  }
  async saveRound(round: RoundRecord): Promise<void> {
    this.rounds.set(round.id, { ...round });
  }
  async saveBet(bet: BetRecord): Promise<void> {
    this.bets.set(bet.id, { ...bet });
  }
  async betsForRound(roundId: string): Promise<BetRecord[]> {
    return [...this.bets.values()].filter((b) => b.roundId === roundId).map((b) => ({ ...b }));
  }
  async unsettledBets(): Promise<BetRecord[]> {
    return [...this.bets.values()].filter((b) => !b.settled && b.status !== "REJECTED").map((b) => ({ ...b }));
  }
}
