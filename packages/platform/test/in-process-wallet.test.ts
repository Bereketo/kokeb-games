import { runWalletConformance } from "@kokeb/wallet-contract/conformance";
import { InProcessWallet } from "../src/in-process-wallet.ts";
import { Ledger } from "../src/ledger.ts";
import { newPlayer, testDb } from "./helpers.ts";

runWalletConformance("InProcessWallet (Postgres ledger)", async () => {
  const db = testDb();
  const ledger = new Ledger(db, { timeoutMs: 120_000 });
  return {
    wallet: new InProcessWallet(ledger, { onUnexpectedError: () => {} }),
    demoGrant: ledger.demoGrant,
    createPlayer: (opts) => newPlayer(db, ledger, opts?.etb ?? 0n),
    verifyIntegrity: async () => {
      const problems = await ledger.verifyIntegrity();
      if (problems.length) throw new Error(`Ledger integrity failed:\n${problems.join("\n")}`);
    },
    teardown: () => db.$disconnect(),
  };
});
