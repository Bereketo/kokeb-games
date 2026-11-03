# apps/game-server

The long-running game process. It runs three games on one round loop and serves players over WebSockets:

| Game | Page | WebSocket |
|---|---|---|
| Crash (classic) | `/` | `/ws` |
| Jet crash: own rounds and chain, 3 bet panels, jet theme | `/jet` | `/ws/jet` |
| 75-ball bingo | `/bingo` | `/ws/bingo` |

The two crash games share the engine, the page and the protocol; the page reads its theme, bet panels and socket from `/api/config?game=jet`. Each has its own provably-fair chain (`CRASH_CHAIN_SECRET` / `JET_CHAIN_SECRET`), so their rounds are independent.

```bash
pnpm dev:game        # from the repo root; restarts on file changes
# open http://localhost:4001 and log in with any name (dev tools)
```

**Run one instance only.** Two instances would run two round loops.

## What's here

| File | Purpose |
|---|---|
| `src/main.ts` | Entry point: builds the hash chain, starts the engine, loop and server, graceful shutdown |
| `src/server.ts` | HTTP routes and WebSocket routing |
| `src/crash-socket.ts` | WebSocket protocol for both crash games |
| `src/bingo-socket.ts`, `src/bingo-store.ts` | Bingo's WebSocket protocol and storage |
| `src/prisma-store.ts` | Stores rounds and bets in the `games` schema |
| `src/session.ts` | Signed player session tokens |
| `src/config.ts` | Settings from `.env` (see `.env.example`) |
| `public/index.html` | Browser test page (becomes the Mini App game screen) |

## HTTP

- `GET /`: test page
- `GET /api/config`: display name, whether dev tools are on
- `GET /api/fairness`: chain commitment, salt, house edge, algorithm, recent rounds
- `POST /dev/login` `{ name }` (dev only): creates a player, returns DEMO and ETB session tokens
- `POST /dev/faucet` `{ token }` (dev only): adds 1,000 ETB to that player

Dev tools are disabled when `NODE_ENV=production`.

## WebSocket `/ws`

Client → server:

```json
{ "type": "auth", "token": "..." }
{ "type": "bet", "id": 1, "slot": 0, "amount": "10.50", "autoCashout": "2.00" }
{ "type": "cancel", "id": 2, "slot": 0 }
{ "type": "cashout", "id": 3, "slot": 0 }
```

Server → client: `welcome` (full state), `tick` (multiplier, ~10/s while flying), `reply` (to each request), `round:betting`, `round:flying`, `round:crashed` (reveals crash point and hash), `bet:placed`, `bet:cashed`, `bet:cancelled` (with `mine: true` on your own bets), `balance` (only yours).

Amounts are birr strings; multipliers in messages are hundredths (`235` = 2.35x).

## Before production

- Set `CRASH_CHAIN_SECRET`, `CRASH_SALT`, `SESSION_SECRET` (the server refuses to start without them in production).
- Publish the chain commitment (printed at startup) somewhere public and timestamped **before** choosing the salt. Then pick the salt from something not yet known at that time, e.g. a future Bitcoin block hash, and publish that too.
- Replace dev login with the platform's Telegram login (roadmap step 3).
