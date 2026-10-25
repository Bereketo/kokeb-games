# Kokeb Games ⭐

**Kokeb** (ኮከብ, "star") is a real-money gaming platform for Ethiopian players, delivered as a Telegram bot and Mini App. Players deposit birr, play games like our **crash game** and **Bingo**, and withdraw their winnings.

> **Status:** early development. The wallet contract and ledger are built and tested; everything else is still to come.

---

## Core idea: games are plug-and-play

The platform (users, wallet, payments) and the games are **separate components**. They talk only through a small, standard **wallet API**, the same "seamless wallet" model the casino industry uses to run one game across many operators.

- Games **never hold money** and **know nothing about Telegram**. They see a player only as an opaque ID and a session token.
- Any platform that implements the wallet API can host our games: the Kokeb Telegram bot today, a website or third-party operator later.
- The same API lets us **add third-party provider games** (other studios' slots, crash games, etc.) next to our own. Our games and provider games plug into the platform the same way.
- Everything ships as **one deployment** for now (a modular monolith). The boundaries live in the code, so a game can be split into its own service later without a rewrite.

```
┌──────────────── PLATFORM ────────────────┐        ┌────────────────── GAMES ──────────────────┐
│ Telegram bot · Mini App · Admin panel    │        │ Our games: crash, bingo                   │
│ Auth (Telegram initData)                 │ wallet │ Provably-fair module                      │
│ Wallet + double-entry ledger             │◀──────▶│ Realtime gateway (WebSockets)             │
│ Payments (Chapa / Telebirr)              │  API   ├───────────────────────────────────────────┤
│ Game catalog & sessions                  │        │ Third-party provider games (later)        │
│ Risk limits · player protection          │        │ call the same API over signed HTTP        │
└──────────────────────────────────────────┘        └───────────────────────────────────────────┘
```

## Player flow

1. Player opens the bot and taps **/start**.
2. The bot asks them to **share their phone number** (one tap; Telegram sends the verified number).
3. We create the player from their Telegram profile and phone.
4. The bot shows an **Open** button that launches the Mini App. The Mini App logs in with Telegram `initData` (no passwords, no OTP).
5. In the lobby they pick a game and choose **Play Now** (real money, ETB) or **Try Demo** (play money).
6. Deposits and withdrawals go through Chapa / Telebirr, tied to their phone number.

## The wallet contract

Defined in [`packages/wallet-contract`](packages/wallet-contract): the `WalletPort` TypeScript interface and its HTTP form, [`openapi.yaml`](packages/wallet-contract/openapi.yaml).

| Operation  | When                | Platform does                                     |
|------------|---------------------|---------------------------------------------------|
| `balance`  | Game opens          | Returns the player's balance                      |
| `debit`    | Player places a bet | Takes the stake, or rejects if funds are short    |
| `credit`   | Round settles       | Pays the win (0 on a loss)                        |
| `rollback` | Something failed    | Reverses an earlier debit as if it never happened |

Rules every implementation follows:

- **Money is integer santim** (1 ETB = 100 santim), `bigint` in code. Never floating point.
- **Idempotent:** each call carries a `txId`, unique per (provider, player). Repeating it returns the stored result with `duplicate: true` and moves no money. Reusing it with a different payload is `TX_CONFLICT`.
- **Credits need a bet:** a credit is only accepted for a round that has a live debit from that player in the same currency.
- **Only debits are rolled back.** Credits are retried until acknowledged, never reversed. Rolling back an unknown debit leaves a marker so that debit is refused if it arrives late.
- **Demo play is just another currency (`DEMO`).** Every player gets a play-money grant; game code is identical for real and demo.
- **Signed over HTTP:** `HMAC-SHA256(secret, timestamp + "." + rawBody)` with a 5-minute timestamp window.
- **Typed errors** (`INSUFFICIENT_FUNDS`, `TX_CONFLICT`, `ROUND_NOT_FOUND`…) each say whether they are safe to retry.

Implementations:

- `InProcessWallet` (`packages/platform`): calls the ledger directly. Used when our games run in the platform process.
- `HttpWallet` (planned): calls the API over signed HTTP. Used when a game runs standalone or for another operator.

Every implementation must pass the shared **conformance suite** (`@kokeb/wallet-contract/conformance`): idempotency, rollbacks, demo isolation, and concurrent bets.

## The ledger

`packages/platform/src/ledger.ts` is double-entry bookkeeping:

- Every money movement is one transaction whose entries sum to zero (player ↔ house, player ↔ cash clearing, player ↔ demo faucet).
- Each operation locks the player's account row, so all operations for one player are strictly serialized: parallel bets can't overdraw, and duplicate or racing requests see each other.
- The database itself enforces the critical rules: player balances can't go negative (CHECK constraint), and ledger entries are append-only (trigger).
- `verifyIntegrity()` checks that the books balance. Run it nightly.

## Components

**Platform**
1. Telegram bot: entry point, phone sharing, menus, notifications
2. Mini App shell: lobby, wallet, history, profile, limits
3. Auth: validates Telegram `initData`, creates and identifies users
4. Wallet / ledger: double-entry accounts, the four wallet operations ✅
5. Payments: Chapa / Telebirr deposits, webhooks, withdrawals
6. Game catalog & sessions: our games and provider games, launch in real or demo mode
7. Risk and player protection: deposit/loss limits, self-exclusion, payout and exposure caps, fraud flags
8. Admin panel: users, transactions, withdrawal approvals, reports, promotions, settings

**Games**

9. Wallet contract + conformance suite ✅
10. Provably fair: hash chain for crash, seed commit/reveal for bingo, public verifier
11. Crash engine: round loop, bets, cashouts
12. Bingo engine: rooms, tickets, draws, winners, prize splits
13. Realtime gateway: WebSocket ticks, draws and balance updates
14. Game UIs

**Shared**

15. Jobs: credit retries, payout queue, nightly reconciliation
16. Infrastructure: Postgres, Redis, logging and monitoring

## Tech stack

All TypeScript on Node.js 22+.

- **Web:** Next.js (Mini App, admin panel, API routes, payment and bot webhooks)
- **Bot:** grammY
- **Game server:** Node with WebSockets (Socket.IO or `ws`)
- **Data:** PostgreSQL via **Prisma 7** (separate `platform` and `games` schemas), Redis (live round state, pub/sub)
- **Jobs:** BullMQ or pg-boss
- **Payments:** Chapa (covers Telebirr and banks)
- **Tests:** Vitest, against a real Postgres

## Repository layout

```
apps/
  web/               # Next.js: Mini App, admin, API, webhooks, bot          (next)
  game-server/       # Node: WebSockets, crash loop, bingo rooms, jobs       (next)
packages/
  wallet-contract/   # WalletPort interface, errors, signing, OpenAPI, conformance suite
  db/                # Prisma schema, migrations, client
  platform/          # ledger, InProcessWallet, players (later: payments, auth, risk)
  games/             # game engines + provably-fair (never imports platform or db)
scripts/
  check-boundaries.mjs  # fails if games import the platform
```

## Architecture rules

- `packages/games` **never imports** `@kokeb/platform` or `@kokeb/db`, and `apps/game-server` never imports the platform. Enforced by `pnpm check:boundaries` in CI.
- No cross-schema queries and no shared DB transactions between platform and games. They interact only through the wallet contract.
- The game loop runs in **exactly one process**. Web instances can scale; the game engine does not run on each of them.
- Game outcomes come **only** from the provably-fair module. No tunable per-round odds.
- Never credit a deposit from a webhook alone: verify the signature, then re-query the payment provider. `ledger.deposit()` is idempotent on the payment reference.
- Credits that fail must be retried until acknowledged, never dropped.
- Show money in **ETB everywhere** in the UI, consistently.

## Getting started

Requirements: Node 22+, pnpm 10 (`corepack enable`), PostgreSQL 16+ (on macOS: [Postgres.app](https://postgresapp.com) or `brew install postgresql@16`).

```bash
cp .env.example .env         # then set DATABASE_URL
pnpm install                 # also generates the Prisma client
createdb kokeb
pnpm db:deploy               # apply migrations
pnpm check                   # boundaries + typecheck + tests
```

Useful scripts:

| Command | What it does |
|---|---|
| `pnpm test` | Run all tests (needs the database) |
| `pnpm typecheck` | Type-check every package |
| `pnpm check:boundaries` | Verify games don't import the platform |
| `pnpm db:migrate` | Create a new migration after editing `schema.prisma` |
| `pnpm db:deploy` | Apply migrations (CI / production) |
| `pnpm --filter @kokeb/db studio` | Browse the database |

Packages are consumed as TypeScript source (no build step); Node 22 runs `.ts` directly and Next.js will transpile them.

## Deployment

The game server needs a long-running process, so this cannot be hosted on serverless platforms such as Vercel. Two processes from the same repo: the Next.js app and the game server. Targets a VPS with PM2/systemd behind Caddy or Nginx, or a platform like Railway, Render or Fly.io. Pick a region close to players (e.g. Europe) to keep crash cashout latency low.

## Roadmap

1. ✅ **Wallet contract + ledger:** contract, OpenAPI spec, double-entry ledger, idempotent operations, conformance tests
2. **Crash game server:** hash chain, round loop, WebSocket protocol, demo mode
3. **Platform MVP:** bot with phone sharing, Mini App lobby, Chapa deposits, manual withdrawals, admin panel
4. **Bingo:** reuses the session and wallet integration to prove plug-and-play
5. **Provider games:** `HttpWallet` endpoints with signing, first third-party integration
6. **Hardening:** load testing, reconciliation jobs, monitoring, public fairness verifier

## License

Proprietary. All rights reserved.
