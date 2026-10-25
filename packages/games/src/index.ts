/**
 * @kokeb/games: our own game engines.
 *
 * Every engine receives a `WalletPort` and moves money only through it, so the
 * same engine runs inside our platform (InProcessWallet) or standalone for
 * another operator (HttpWallet).
 *
 * Engines arrive in the next roadmap step (crash, then bingo).
 */
export type { WalletPort } from "@kokeb/wallet-contract";
