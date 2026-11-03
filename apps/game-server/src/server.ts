/**
 * HTTP front of the game server, plus WebSocket routing:
 *   /ws        classic crash game   (crash-socket.ts)
 *   /ws/jet    jet crash game       (crash-socket.ts)
 *   /ws/bingo  75-ball bingo        (bingo-socket.ts)
 *
 * Amounts on the wire are decimal birr strings ("10.50"); multipliers are
 * hundredths (235 = 2.35x). Internally everything is santim / hundredths.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { WebSocketServer } from "ws";
import type { Db } from "@kokeb/db";
import type { BingoEngine, CrashEngine } from "@kokeb/games";
import { loginWithTelegram, TelegramAuthError, upsertPlayer, type Ledger } from "@kokeb/platform";
import { formatMinor, type WalletPort } from "@kokeb/wallet-contract";
import type { config as Config } from "./config.ts";
import { attachBingo } from "./bingo-socket.ts";
import { attachCrash } from "./crash-socket.ts";
import { maskLabel, signSession, verifySession } from "./session.ts";

interface Deps {
  /** The classic crash game. */
  engine: CrashEngine;
  /** The jet crash game; optional. */
  jet?: CrashEngine;
  /** 75-ball bingo; optional so the crash game can run alone. */
  bingo?: BingoEngine;
  wallet: WalletPort;
  ledger: Ledger;
  db: Db;
  config: typeof Config;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INDEX_HTML = new URL("../public/index.html", import.meta.url);
const BINGO_HTML = new URL("../public/bingo.html", import.meta.url);

export function startServer(deps: Deps) {
  const { config } = deps;

  const http = createServer((req, res) => {
    handleHttp(deps, req, res).catch((err) => {
      console.error("[http]", err);
      json(res, 500, { error: "internal error" });
    });
  });

  // Several WebSocket endpoints on one HTTP server: route upgrades by path.
  const sockets = new Map<string, { wss: WebSocketServer; close(): void }>();
  sockets.set("/ws", attachCrash({ engine: deps.engine, wallet: deps.wallet, config, displayName: config.displayName }));
  if (deps.jet) sockets.set("/ws/jet", attachCrash({ engine: deps.jet, wallet: deps.wallet, config, displayName: config.jetDisplayName }));
  if (deps.bingo) sockets.set("/ws/bingo", attachBingo({ engine: deps.bingo, wallet: deps.wallet, config }));
  http.on("upgrade", (req, socket, head) => {
    const s = sockets.get(new URL(req.url ?? "/", "http://localhost").pathname);
    if (!s) return socket.destroy();
    s.wss.handleUpgrade(req, socket, head, (ws) => s.wss.emit("connection", ws, req));
  });

  http.listen(config.port, () => console.log(`[game-server] listening on http://localhost:${config.port}`));

  return {
    http,
    async close() {
      // Cut live sockets: http.close() alone waits for every keep-alive and
      // WebSocket connection to end on its own, which can be never.
      for (const s of sockets.values()) s.close();
      const closed = new Promise<void>((r) => http.close(() => r()));
      http.closeAllConnections();
      await closed;
    },
  };
}

// ───────────────────────── HTTP ─────────────────────────

async function handleHttp(deps: Deps, req: IncomingMessage, res: ServerResponse) {
  const { config } = deps;
  const url = new URL(req.url ?? "/", "http://localhost");
  // ?game=jet selects the jet crash game for the crash API routes.
  const isJet = url.searchParams.get("game") === "jet" && Boolean(deps.jet);
  const engine = isJet ? deps.jet! : deps.engine;

  // The jet game uses the same page; it reads its theme and settings from /api/config?game=jet.
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || (url.pathname === "/jet" && deps.jet))) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(await readFile(INDEX_HTML));
  }

  if (req.method === "GET" && (url.pathname === "/bingo" || url.pathname === "/bingo.html") && deps.bingo) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(await readFile(BINGO_HTML));
  }

  if (req.method === "GET" && url.pathname === "/api/bingo/config" && deps.bingo) {
    return json(res, 200, {
      displayName: config.bingoDisplayName,
      devTools: config.devTools,
      telegramLogin: Boolean(config.telegramBotToken),
      ...deps.bingo.publicConfig(),
      // Every cartela's numbers: card #N is deck[N-1], 25 numbers row by row, 0 = free space.
      deck: deps.bingo.deck,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, {
      game: isJet ? "jet" : "crash",
      displayName: isJet ? config.jetDisplayName : config.displayName,
      theme: isJet ? "jet" : "star",
      wsPath: isJet ? "/ws/jet" : "/ws",
      slots: engine.config.slots,
      bettingMs: engine.config.bettingMs,
      devTools: config.devTools,
      telegramLogin: Boolean(config.telegramBotToken),
      // Links to the other games on this server.
      games: [
        { path: "/", name: config.displayName },
        ...(deps.jet ? [{ path: "/jet", name: config.jetDisplayName }] : []),
        ...(deps.bingo ? [{ path: "/bingo", name: config.bingoDisplayName }] : []),
      ],
    });
  }

  if (req.method === "GET" && url.pathname === "/api/fairness") {
    const snap = engine.snapshot();
    return json(res, 200, {
      commitment: snap.commitment,
      salt: snap.config.salt,
      houseEdgeBps: snap.config.houseEdgeBps,
      algorithm: [
        "Each round uses one hash from a pre-generated SHA-256 chain, played in reverse.",
        "SHA-256(hash of game n) equals the hash of game n-1; SHA-256(hash of game 1) equals the commitment.",
        "hmac = HMAC-SHA256(key = game hash bytes, message = salt); r = first 52 bits of hmac; X = r / 2^52",
        "crash = max(1.00, floor((10000 - houseEdgeBps) / 100 / (1 - X)) / 100)",
      ],
      recent: snap.history,
    });
  }

  // Mini App login: Telegram's signed initData in, session tokens out.
  if (req.method === "POST" && url.pathname === "/auth/telegram") {
    if (!config.telegramBotToken) return json(res, 503, { error: "Telegram login is not configured (TELEGRAM_BOT_TOKEN)" });
    const body = await readJson(req);
    try {
      const r = await loginWithTelegram(deps.db, String(body.initData ?? ""), {
        botToken: config.telegramBotToken,
        sessionSecret: config.sessionSecret,
        ttlMs: SESSION_TTL_MS,
      });
      return json(res, 200, { label: r.label, firstName: r.firstName, hasPhone: r.hasPhone, tokens: r.tokens });
    } catch (err) {
      if (err instanceof TelegramAuthError) return json(res, 401, { error: err.message });
      throw err;
    }
  }

  if (config.devTools && req.method === "POST" && url.pathname === "/dev/login") {
    const body = await readJson(req);
    const name = String(body.name ?? "").trim().slice(0, 32) || `player${Math.floor(Math.random() * 1000)}`;
    // Dev players get negative ids so they can never collide with real Telegram users.
    const telegramId = -BigInt(`0x${createHash("sha256").update(name).digest("hex").slice(0, 12)}`);
    const player = await upsertPlayer(deps.db, { telegramId, firstName: name, username: name });
    const label = maskLabel(name);
    const exp = Date.now() + SESSION_TTL_MS;
    return json(res, 200, {
      label,
      tokens: {
        DEMO: signSession(config.sessionSecret, { playerId: player.id, label, currency: "DEMO", exp }),
        ETB: signSession(config.sessionSecret, { playerId: player.id, label, currency: "ETB", exp }),
      },
    });
  }

  if (config.devTools && req.method === "POST" && url.pathname === "/dev/faucet") {
    const body = await readJson(req);
    const session = verifySession(config.sessionSecret, body.token);
    if (!session) return json(res, 401, { error: "invalid session" });
    const result = await deps.ledger.deposit({ playerId: session.playerId, amount: 100_000n, source: "dev-faucet", reference: randomUUID() });
    return json(res, 200, { balance: formatMinor(result.balance) });
  }

  json(res, 404, { error: "not found" });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error("body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
