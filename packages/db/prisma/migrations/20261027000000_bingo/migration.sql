-- CreateEnum
CREATE TYPE "games"."BingoGameStatus" AS ENUM ('LOBBY', 'COUNTDOWN', 'DRAWING', 'FINISHED', 'VOID');

-- CreateEnum
CREATE TYPE "games"."BingoCardStatus" AS ENUM ('PENDING', 'HELD', 'WON', 'LOST', 'ELIMINATED', 'CANCELLED', 'REJECTED');

-- CreateTable
CREATE TABLE "games"."bingo_games" (
    "id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "seed" TEXT NOT NULL,
    "seed_hash" TEXT NOT NULL,
    "status" "games"."BingoGameStatus" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "countdown_ends_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "calls" INTEGER NOT NULL DEFAULT 0,
    "pot" BIGINT NOT NULL DEFAULT 0,
    "commission" BIGINT NOT NULL DEFAULT 0,
    "prize" BIGINT NOT NULL DEFAULT 0,
    "winners" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "bingo_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "games"."bingo_cards" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "room_id" TEXT NOT NULL,
    "player_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "card_number" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stake" BIGINT NOT NULL,
    "status" "games"."BingoCardStatus" NOT NULL,
    "payout" BIGINT,
    "settled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bingo_cards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "bingo_games_status_idx" ON "games"."bingo_games"("status");

-- CreateIndex
CREATE INDEX "bingo_games_room_id_created_at_idx" ON "games"."bingo_games"("room_id", "created_at");

-- CreateIndex
CREATE INDEX "bingo_cards_game_id_idx" ON "games"."bingo_cards"("game_id");

-- CreateIndex
CREATE INDEX "bingo_cards_settled_idx" ON "games"."bingo_cards"("settled");

-- CreateIndex
CREATE INDEX "bingo_cards_player_id_created_at_idx" ON "games"."bingo_cards"("player_id", "created_at");

-- AddForeignKey
ALTER TABLE "games"."bingo_cards" ADD CONSTRAINT "bingo_cards_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"."bingo_games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
