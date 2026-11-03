/**
 * WebSocket front of a crash-style game (the classic crash game at /ws, the
 * jet game at /ws/jet). Same protocol for both:
 *
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
 *     bet:cancelled, bet:cashed (with mine: true for your own), balance (only yours)
 */
import { WebSocketServer, type WebSocket } from "ws";
import { GameError, type CrashEngine, type CrashEvent } from "@kokeb/games";
import { formatMinor, parseMajor, type WalletPort } from "@kokeb/wallet-contract";
import type { config as Config } from "./config.ts";
import { verifySession, type Session } from "./session.ts";

interface Client {
  ws: WebSocket;
  session: Session | null;
  /** simple token bucket */
  tokens: number;
  last: number;
}

export function attachCrash(deps: { engine: CrashEngine; wallet: WalletPort; config: typeof Config; displayName: string }) {
  const { engine, displayName } = deps;
  const clients = new Set<Client>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  wss.on("connection", (ws) => {
    const client: Client = { ws, session: null, tokens: 20, last: Date.now() };
    clients.add(client);
    send(ws, { type: "welcome", state: engine.snapshot(), you: null, displayName });

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

  return {
    wss,
    close() {
      clearInterval(ticker);
      for (const c of clients) c.ws.terminate();
      wss.close();
    },
  };
}

async function handleMessage(
  deps: { engine: CrashEngine; wallet: WalletPort; config: typeof Config; displayName: string },
  client: Client,
  msg: Record<string, unknown>,
) {
  const { engine, wallet, config, displayName } = deps;
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
        displayName,
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
