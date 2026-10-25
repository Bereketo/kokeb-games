import { existsSync } from "node:fs";
import { randomInt } from "node:crypto";
import { createDb, type Db } from "@kokeb/db";
import { upsertPlayer } from "../src/players.ts";
import type { Ledger } from "../src/ledger.ts";

const rootEnv = new URL("../../../.env", import.meta.url);
if (!process.env.DATABASE_URL && existsSync(rootEnv)) process.loadEnvFile(rootEnv);

export function testDb(): Db {
  return createDb();
}

let reference = 0;

/** Register a fresh player and optionally fund their real wallet. */
export async function newPlayer(db: Db, ledger: Ledger, etb = 0n): Promise<string> {
  const telegramId = BigInt(randomInt(1, 2 ** 47)) * 1000n + BigInt(randomInt(0, 1000));
  const player = await upsertPlayer(db, { telegramId, firstName: "Test" });
  if (etb > 0n) {
    await ledger.deposit({ playerId: player.id, amount: etb, source: "test-funding", reference: `fund-${Date.now()}-${++reference}` });
  }
  return player.id;
}
