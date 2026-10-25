# apps/game-server

Long-running Node process: WebSocket gateway, the crash game loop, bingo rooms and background jobs. Runs our game engines from `@kokeb/games` with a `WalletPort` (in-process today, HTTP later).

Must never import `@kokeb/platform` (enforced by `pnpm check:boundaries`).

Not started yet. Roadmap step 2.
