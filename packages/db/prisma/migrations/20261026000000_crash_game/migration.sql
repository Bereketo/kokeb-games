-- CreateEnum
CREATE TYPE "games"."CrashRoundStatus" AS ENUM ('BETTING', 'FLYING', 'CRASHED', 'VOID');

-- CreateEnum
CREATE TYPE "games"."CrashBetStatus" AS ENUM ('PENDING', 'PLACED', 'CASHED_OUT', 'LOST', 'CANCELLED', 'REJECTED');

-- CreateTable
CREATE TABLE "games"."crash_rounds" (
    "id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "crash_point" INTEGER NOT NULL,
    "status" "games"."CrashRoundStatus" NOT NULL,
    "betting_started_at" TIMESTAMP(3) NOT NULL,
    "flying_started_at" TIMESTAMP(3),
    "crashed_at" TIMESTAMP(3),

    CONSTRAINT "crash_rounds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games"."crash_bets" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "player_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "auto_cashout" INTEGER,
    "status" "games"."CrashBetStatus" NOT NULL,
    "cashout_multiplier" INTEGER,
    "payout" BIGINT,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crash_bets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "crash_rounds_chain_number_key" ON "games"."crash_rounds"("chain", "number");

-- CreateIndex
CREATE INDEX "crash_bets_settled_idx" ON "games"."crash_bets"("settled");

-- CreateIndex
CREATE INDEX "crash_bets_player_id_created_at_idx" ON "games"."crash_bets"("player_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "crash_bets_round_id_player_id_slot_key" ON "games"."crash_bets"("round_id", "player_id", "slot");

-- AddForeignKey
ALTER TABLE "games"."crash_bets" ADD CONSTRAINT "crash_bets_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "games"."crash_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
