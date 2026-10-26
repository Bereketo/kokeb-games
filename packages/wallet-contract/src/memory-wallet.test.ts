import { randomUUID } from "node:crypto";
import { runWalletConformance } from "./conformance.ts";
import { MemoryWallet } from "./memory-wallet.ts";

// The test double must obey the same contract as the real ledger.
runWalletConformance("MemoryWallet", async () => {
  const wallet = new MemoryWallet();
  return {
    wallet,
    demoGrant: wallet.demoGrant,
    createPlayer: async (opts) => {
      const id = randomUUID();
      wallet.addPlayer(id, opts?.etb ?? 0n);
      return id;
    },
  };
});
