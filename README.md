# Kokeb Games ⭐

**Kokeb** (ኮከብ, "star") is a real-money gaming platform for Ethiopian players, delivered as a Telegram bot and Mini App. Players deposit birr, play games like **Aviator** (crash) and **Bingo**, and withdraw their winnings.

> **Status:** early development. Nothing here is production-ready yet.

---

## Core idea: games are plug-and-play

The platform (users, wallet, payments) and the games are **separate components**. They talk only through a small, standard **wallet API**, the same "seamless wallet" model the casino industry uses to run one game across many operators.

- Games **never hold money** and **know nothing about Telegram**. They see a player only as an opaque ID and a session token.
- Any platform that implements the wallet API can host our games: the Kokeb Telegram bot today, a website or third-party operator later.
- Everything ships as **one deployment** for now (a modular monolith). The boundaries live in the code, so a game can be split into its own service later without a rewrite.

```
┌──────────────── PLATFORM ────────────────┐        ┌────────────────── GAMES ──────────────────┐
│ Telegram bot · Mini App · Admin panel    │        │ Session API (launch a game for a player)  │
│ Auth (Telegram initData)                 │ wallet │ Aviator engine · Bingo engine             │
│ Wallet + double-entry ledger             │◀──────▶│ Provably-fair module                      │
│ Payments (Chapa / Telebirr)              │  port  │ Realtime gateway (WebSockets)             │
│ Risk limits · player protection          │        │ Game UIs                                  │
└──────────────────────────────────────────┘        └───────────────────────────────────────────┘
```

## The wallet contract

Games call four operations. Each one carries a unique `tx_id`, is **idempotent** (a repeated `tx_id` returns the stored result), and is **signed** (HMAC-SHA256) when it goes over HTTP.

| Operation  | When                | Platform does                                |
|------------|---------------------|----------------------------------------------|
| `balance`  | Game opens          | Returns the player's balance                 |
| `debit`    | Player places a bet | Takes the stake, or rejects if funds are short |
| `credit`   | Round settles       | Pays the win (0 on a loss)                   |
| `rollback` | Something failed    | Reverses an earlier debit or credit          |

The games depend only on a `WalletPort` interface, with two adapters:

- `InProcessWallet`: calls the platform ledger directly (used in the single deployment)
- `HttpWallet`: calls an external wallet API over signed HTTP (used when games run standalone or for another operator)

Switching between them is a config change.

## Components

**Platform**
1. Telegram bot: entry point, menus, notifications
2. Mini App shell: lobby, wallet, history, profile, limits
3. Auth: validates Telegram `initData`, creates and identifies users
4. Wallet / ledger: double-entry accounts, the four wallet operations
5. Payments: Chapa / Telebirr deposits, webhooks, withdrawals
6. Risk and player protection: deposit/loss limits, self-exclusion, payout and exposure caps, fraud flags
7. Admin panel: users, transactions, withdrawal approvals, reports, settings

**Games**

8. Session API: launches a game and returns a URL + token
9. Wallet port + adapters
10. Provably fair: hash chain for crash, seed commit/reveal for bingo, public verifier
11. Aviator engine: round loop, bets, cashouts
12. Bingo engine: rooms, tickets, draws, winners, prize splits
13. Realtime gateway: WebSocket ticks, draws and balance updates
14. Game UIs

**Shared**

15. Jobs: credit retries, payout queue, nightly reconciliation
16. Infrastructure: Postgres, Redis, logging and monitoring

## Tech stack

All TypeScript on Node.js.

- **Web:** Next.js (Mini App, admin panel, API routes, payment and bot webhooks)
- **Bot:** grammY
- **Game server:** Node with WebSockets (Socket.IO or `ws`)
- **Data:** PostgreSQL (separate `platform` and `games` schemas), Redis (live round state, pub/sub)
- **Jobs:** BullMQ or pg-boss
- **Payments:** Chapa (covers Telebirr and banks)

## Repository layout

```
apps/
  web/            # Next.js: Mini App, admin, API, webhooks, bot
  game-server/    # Node: WebSockets, Aviator loop, Bingo rooms, jobs
packages/
  platform/       # ledger, payments, auth, risk
  games/          # engines, wallet port, provably-fair (never imports from platform)
  db/             # database schema and migrations
```

## Architecture rules

- `packages/games` **never imports** from `packages/platform` (enforced in CI).
- No cross-schema queries and no shared DB transactions between platform and games. They interact only through the wallet port.
- The game loop runs in **exactly one process**. Web instances can scale; the game engine does not run on each of them.
- Game outcomes come **only** from the provably-fair module. No tunable per-round odds.
- Never credit a deposit from a webhook alone: verify the signature, then re-query the payment provider.
- Credits that fail must be retried until acknowledged, never dropped.

## Running

The game server needs a long-running process, so this cannot be hosted on serverless platforms such as Vercel. Two processes from the same repo:

```bash
pnpm install
pnpm --filter web start           # next start
pnpm --filter game-server start   # node game-server
```

Targets a VPS with PM2/systemd behind Caddy or Nginx, or a platform like Railway, Render or Fly.io. Pick a region close to players (e.g. Europe) to keep crash cashout latency low.

_Setup steps and environment variables will be added as the code lands._

## Roadmap

1. **Wallet contract + ledger:** spec, double-entry ledger, idempotent signed endpoints, conformance tests
2. **Aviator game server:** hash chain, round loop, WebSocket protocol, mock wallet
3. **Platform MVP:** bot, Mini App, Chapa deposits, manual withdrawals, admin panel
4. **Bingo:** reuses the session and wallet integration to prove plug-and-play
5. **Hardening:** load testing, reconciliation, monitoring, public fairness verifier

## License

Proprietary. All rights reserved.
