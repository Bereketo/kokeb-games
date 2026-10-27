/**
 * @kokeb/games: our own game engines.
 *
 * Every engine receives a `WalletPort` and moves money only through it, so the
 * same engine runs inside our platform (InProcessWallet) or standalone for
 * another operator (HttpWallet). Nothing here may import the platform or db.
 */
export type { WalletPort } from "@kokeb/wallet-contract";
export { HashChain, sha256, verifyChainLink } from "./provably-fair/hash-chain.ts";
export { crashPointFromHash, formatMultiplier } from "./crash/crash-point.ts";
export { GROWTH_PER_MS, multiplierAt, msToReach } from "./crash/multiplier.ts";
export { CrashEngine, type CrashEngineDeps, type PlaceBetInput } from "./crash/engine.ts";
export { SettlementQueue, betTxIds } from "./crash/settlement.ts";
export { MemoryCrashStore } from "./crash/memory-store.ts";
export * from "./crash/types.ts";

// 75-ball bingo
export { BingoEngine, type BingoEngineDeps } from "./bingo/engine.ts";
export { MemoryBingoStore } from "./bingo/memory-store.ts";
export { BALLS, FREE, LETTERS, PATTERNS, buildDeck, drawOrder, firstWinningCall, letterFor, seedHash, winningPattern, type Card } from "./bingo/cards.ts";
export * from "./bingo/types.ts";
export { SeededRng } from "./common/rng.ts";
export { RetryQueue } from "./common/retry-queue.ts";
