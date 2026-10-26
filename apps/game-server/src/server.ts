/**
 * HTTP + WebSocket front of the game server.
 *
 * WebSocket protocol (JSON messages, path /ws):
 *   client -> server
 *     { type: "auth", token }
 *     { type: "bet", id, slot, amount: "10.50", autoCashout: "2.00" | null }
 *     { type: "cancel", id, slot }
 *     { type: "cashout", id, slot }
 *   server -> client
 *     { type: "welcome", state, you }          on connect and after auth
 *     { type: "tick", multiplier, serverTime } ~10x per second while flying
 *     { type: "reply", id, ok, bet? , code?, message? }
 *     engine events: round:betting, round:flying, round:crashed, bet:placed,
 *     bet:cancelled, bet:cashed, balance (balance only to its owner)
 *
 * Amounts on the wire are decimal birr strings ("10.50"); multipliers are
 * decimal strings ("2.35"). Internally everything is santim / hundredths.
 */
import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { Db } from "@kokeb/db";
import { GameError, type CrashEngine, type CrashEvent } from "@kokeb/games";
import { upsertPlayer, type Ledger } from "@kokeb/platform";
import { formatMinor, parseMajor, type WalletPort } from "@kokeb/wallet-contract";
import type { config as Config } from "./config.ts";
import { maskLabel, signSession, verifySession, type Session } from "./session.ts";

interface Deps {
  engine: CrashEngine;
  wallet: WalletPort;
  ledger: Ledger;
  db: Db;
  config: typeof Config;
}

interface Client {
  ws: WebSocket;
  session: Session | null;
  /** simple token bucket */
  tokens: number;
  last: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const INDEX_HTML = new URL("../public/index.html", import.meta.url);

export function startServer(deps: Deps) {
  const { engine, config } = deps;
  const clients = new Set<Client>();

  const http = createServer((req, res) => {
    handleHttp(deps, req, res).catch((err) => {
      console.error("[http]", err);
      json(res, 500, { error: "internal error" });
    });
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 4 * 1024 });

  wss.on("connection", (ws) => {
    const client: Client = { ws, session: null, tokens: 20, last: Date.now() };
    clients.add(client);
    send(ws, { type: "welcome", state: engine.snapshot(), you: null, displayName: config.displayName });

    ws.on("message", (raw) => {
      if (!allow(client)) return send(ws, { type: "reply", id: null, ok: false, code: "RATE_LIMITED", message: "slow down" });
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void handleMessage(deps, client, msg);
    });
    ws.on("close", () => clients.delete(client));
    ws.on("error", () => clients.delete(client));
  });

  // Fan engine events out to connected players.
  engine.on((event: CrashEvent) => {
    if (event.type === "balance") {
      for (const c of clients) {
        if (c.session?.playerId === event.playerId && c.session.currency === event.currency) {
          send(c.ws, { type: "balance", currency: event.currency, balance: formatMinor(BigInt(event.balance)) });
        }
      }
      return;
    }
    if (event.type === "settlement:failed") return; // internal only
    if (event.type === "bet:placed" || event.type === "bet:cancelled" || event.type === "bet:cashed") {
      const { playerId, ...rest } = event;
      const publicPayload = JSON.stringify(rest);
      const ownerPayload = JSON.stringify({ ...rest, mine: true });
      for (const c of clients) {
        if (c.ws.readyState !== c.ws.OPEN) continue;
        const owner = c.session?.playerId === playerId && c.session.currency === event.bet.currency;
        c.ws.send(owner ? ownerPayload : publicPayload);
      }
      return;
    }
    const payload = JSON.stringify(event);
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  });

  // Live multiplier while flying (clients also animate locally between ticks).
  const ticker = setInterval(() => {
    const snap = engine.snapshot();
    if (snap.round?.status !== "FLYING") return;
    const payload = JSON.stringify({ type: "tick", multiplier: snap.multiplier, serverTime: snap.serverTime });
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  }, 100);

  http.listen(config.port, () => console.log(`[game-server] listening on http://localhost:${config.port}`));

  return {
    http,
    async close() {
      clearInterval(ticker);
      // Cut live sockets: http.close() alone waits for every keep-alive and
      // WebSocket connection to end on its own, which can be never.
      for (const c of clients) c.ws.terminate();
      wss.close();
      const closed = new Promise<void>((r) => http.close(() => r()));
      http.closeAllConnections();
      await closed;
    },
  };
}

// ───────────────────────── WebSocket messages ─────────────────────────

async function handleMessage(deps: Deps, client: Client, msg: Record<string, unknown>) {
  const { engine, wallet, config } = deps;
  const id = typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null;
  const reply = (body: object) => send(client.ws, { type: "reply", id, ...body });

  try {
    if (msg.type === "auth") {
      const session = verifySession(config.sessionSecret, msg.token);
      if (!session) return reply({ ok: false, code: "UNAUTHORIZED", message: "invalid or expired session" });
      client.session = session;
      const { balance } = await wallet.balance({ playerId: session.playerId, currency: session.currency });
      send(client.ws, {
        type: "welcome",
        state: engine.snapshot(),
        displayName: config.displayName,
        you: { label: session.label, currency: session.currency, balance: formatMinor(balance), bets: engine.playerBets(session.playerId) },
      });
      return reply({ ok: true });
    }

    const session = client.session;
    if (!session) return reply({ ok: false, code: "UNAUTHORIZED", message: "log in first" });
    const slot = Number(msg.slot);

    if (msg.type === "bet") {
      const amount = parseMajor(String(msg.amount ?? ""));
      const auto = msg.autoCashout == null || msg.autoCashout === "" ? null : Math.round(Number(msg.autoCashout) * 100);
      if (auto !== null && !Number.isFinite(auto)) return reply({ ok: false, code: "INVALID_BET", message: "bad auto cash-out" });
      const bet = await engine.placeBet({ playerId: session.playerId, label: session.label, currency: session.currency, slot, amount, autoCashout: auto });
      return reply({ ok: true, bet });
    }
    if (msg.type === "cancel") {
      await engine.cancelBet(session.playerId, slot);
      return reply({ ok: true });
    }
    if (msg.type === "cashout") {
      return reply({ ok: true, bet: engine.cashout(session.playerId, slot) });
    }
    reply({ ok: false, code: "UNKNOWN", message: "unknown message type" });
  } catch (err) {
    if (err instanceof GameError) return reply({ ok: false, code: err.code, message: err.message });
    if (err instanceof Error && /Invalid money amount/.test(err.message)) {
      return reply({ ok: false, code: "INVALID_BET", message: "enter an amount like 10 or 10.50" });
    }
    console.error("[ws]", err);
    reply({ ok: false, code: "INTERNAL", message: "something went wrong" });
  }
}

function allow(c: Client): boolean {
  const now = Date.now();
  c.tokens = Math.min(20, c.tokens + ((now - c.last) / 1000) * 10);
  c.last = now;
  if (c.tokens < 1) return false;
  c.tokens -= 1;
  return true;
}

function send(ws: WebSocket, body: object) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(body));
}

// ───────────────────────── HTTP ─────────────────────────

async function handleHttp(deps: Deps, req: IncomingMessage, res: ServerResponse) {
  const { engine, config } = deps;
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(await readFile(INDEX_HTML));
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    return json(res, 200, { displayName: config.displayName, devTools: config.devTools });
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
    if (raw.length > 4096) throw new Error("body too large");
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
