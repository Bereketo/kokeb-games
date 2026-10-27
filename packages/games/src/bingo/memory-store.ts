import type { BingoCardRecord, BingoGameRecord, BingoStore } from "./types.ts";

/** In-memory BingoStore for tests. */
export class MemoryBingoStore implements BingoStore {
  readonly games = new Map<string, BingoGameRecord>();
  readonly cards = new Map<string, BingoCardRecord>();

  async openGames() {
    return [...this.games.values()].filter((g) => g.status !== "FINISHED" && g.status !== "VOID").map((g) => ({ ...g }));
  }
  async saveGame(g: BingoGameRecord) {
    this.games.set(g.id, { ...g, winners: g.winners.map((w) => ({ ...w })) });
  }
  async saveCard(c: BingoCardRecord) {
    this.cards.set(c.id, { ...c });
  }
  async cardsForGame(gameId: string) {
    return [...this.cards.values()].filter((c) => c.gameId === gameId).map((c) => ({ ...c }));
  }
  async unsettledCards() {
    return [...this.cards.values()].filter((c) => !c.settled && c.status !== "REJECTED").map((c) => ({ ...c }));
  }
  async recentGames(roomId: string, limit: number) {
    return [...this.games.values()]
      .filter((g) => g.roomId === roomId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((g) => ({ ...g }));
  }
}
