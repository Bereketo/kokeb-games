-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "games";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "platform";

-- CreateEnum
CREATE TYPE "platform"."PlayerStatus" AS ENUM ('ACTIVE', 'BLOCKED', 'SELF_EXCLUDED');

-- CreateEnum
CREATE TYPE "platform"."ProviderKind" AS ENUM ('INTERNAL', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "platform"."SessionMode" AS ENUM ('REAL', 'DEMO');

-- CreateEnum
CREATE TYPE "platform"."Currency" AS ENUM ('ETB', 'DEMO');

-- CreateEnum
CREATE TYPE "platform"."AccountKind" AS ENUM ('PLAYER', 'HOUSE_GAMING', 'CASH_CLEARING', 'DEMO_FAUCET');

-- CreateEnum
CREATE TYPE "platform"."LedgerTxType" AS ENUM ('BET', 'WIN', 'ROLLBACK', 'DEPOSIT', 'WITHDRAWAL', 'DEMO_GRANT');

-- CreateTable
CREATE TABLE "platform"."players" (
    "id" UUID NOT NULL,
    "telegram_id" BIGINT NOT NULL,
    "phone" TEXT,
    "username" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT,
    "language" TEXT,
    "status" "platform"."PlayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."game_providers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "platform"."ProviderKind" NOT NULL,
    "launch_url" TEXT,
    "wallet_secret" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "game_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."games" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "provider_game_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "demo_enabled" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."game_sessions" (
    "id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "player_id" UUID NOT NULL,
    "game_id" TEXT NOT NULL,
    "mode" "platform"."SessionMode" NOT NULL,
    "currency" "platform"."Currency" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "game_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."accounts" (
    "id" UUID NOT NULL,
    "kind" "platform"."AccountKind" NOT NULL,
    "currency" "platform"."Currency" NOT NULL,
    "player_id" UUID,
    "system_key" TEXT,
    "balance" BIGINT NOT NULL DEFAULT 0,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."ledger_transactions" (
    "id" UUID NOT NULL,
    "type" "platform"."LedgerTxType" NOT NULL,
    "currency" "platform"."Currency" NOT NULL,
    "source" TEXT NOT NULL,
    "player_id" UUID,
    "external_tx_id" TEXT NOT NULL,
    "game_id" TEXT,
    "round_id" TEXT,
    "amount" BIGINT NOT NULL,
    "original_external_tx_id" TEXT,
    "rolled_back" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform"."ledger_entries" (
    "id" BIGSERIAL NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount" BIGINT NOT NULL,
    "balance_after" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "players_telegram_id_key" ON "platform"."players"("telegram_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_phone_key" ON "platform"."players"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "games_provider_id_provider_game_id_key" ON "platform"."games"("provider_id", "provider_game_id");

-- CreateIndex
CREATE UNIQUE INDEX "game_sessions_token_key" ON "platform"."game_sessions"("token");

-- CreateIndex
CREATE INDEX "game_sessions_player_id_idx" ON "platform"."game_sessions"("player_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_system_key_key" ON "platform"."accounts"("system_key");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_player_id_currency_key" ON "platform"."accounts"("player_id", "currency");

-- CreateIndex
CREATE INDEX "ledger_transactions_source_player_id_round_id_idx" ON "platform"."ledger_transactions"("source", "player_id", "round_id");

-- CreateIndex
CREATE INDEX "ledger_transactions_rollback_lookup_idx" ON "platform"."ledger_transactions"("source", "player_id", "original_external_tx_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_transactions_source_player_id_external_tx_id_key" ON "platform"."ledger_transactions"("source", "player_id", "external_tx_id");

-- CreateIndex
CREATE INDEX "ledger_entries_account_id_id_idx" ON "platform"."ledger_entries"("account_id", "id");

-- CreateIndex
CREATE INDEX "ledger_entries_transaction_id_idx" ON "platform"."ledger_entries"("transaction_id");

-- AddForeignKey
ALTER TABLE "platform"."games" ADD CONSTRAINT "games_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "platform"."game_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."game_sessions" ADD CONSTRAINT "game_sessions_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "platform"."players"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."game_sessions" ADD CONSTRAINT "game_sessions_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "platform"."games"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."accounts" ADD CONSTRAINT "accounts_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "platform"."players"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."ledger_entries" ADD CONSTRAINT "ledger_entries_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "platform"."ledger_transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform"."ledger_entries" ADD CONSTRAINT "ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "platform"."accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Hand-written safety rules (Prisma does not model these) ───

-- A player wallet can never go negative, whatever the application code does.
ALTER TABLE "platform"."accounts" ADD CONSTRAINT "accounts_balance_non_negative" CHECK ("allow_negative" OR "balance" >= 0);

-- Transaction amounts are always >= 0; direction comes from the type.
ALTER TABLE "platform"."ledger_transactions" ADD CONSTRAINT "ledger_transactions_amount_non_negative" CHECK ("amount" >= 0);

-- Ledger history is append-only: entries can never be changed or deleted.
CREATE FUNCTION "platform"."forbid_ledger_entry_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "platform"."ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "platform"."forbid_ledger_entry_change"();
