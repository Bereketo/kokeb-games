/**
 * WebSocket front of 75-ball bingo, path /ws/bingo.
 *
 * client -> server
 *   { type: "auth", token }                    (send again with the other token to switch Demo/Real)
 *   { type: "pick", id, roomId, card }
 *   { type: "release", id, roomId, card }
 *   { type: "claim", id, roomId, card }        (the BINGO button)
 * server -> client
 *   { type: "welcome", rooms, you }
 *   { type: "bingo:room", room }               room state changed (picks, countdown, start, claims, results)
 *   { type: "bingo:ball", roomId, gameId, ball, index }
 *   { type: "bingo:claim", roomId, cardNumber, label, valid, auto }
 *   { type: "bingo:card", roomId, gameId, cardNumber, status, payout }   only your own cartelas
 *   { type: "balance", currency, balance }     only yours
 *   { type: "reply", id, ok, code?, message?, valid?, pattern? }
 */
import { WebSocketServer, type WebSocket } from "ws";
import { BingoError, type BingoEngine, type BingoEvent } from "@kokeb/games";
import { formatMinor, type WalletPort } from "@kokeb/wallet-contract";
import type { config as Config } from "./config.ts";
import { verifySession, type Session } from "./session.ts";

interface Client {
  ws: WebSocket;
  session: Session | null;
  tokens: number;
  last: number;
}

export function attachBingo(deps: { engine: BingoEngine; wallet: WalletPort; config: typeof Config }) {
  const { engine, wallet, config } = deps;
  const clients = new Set<Client>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  wss.on("connection", (ws) => {
    const client: Client = { ws, session: null, tokens: 20, last: Date.now() };
    clients.add(client);
    send(ws, { type: "welcome", rooms: engine.roomsView(), you: null });
    ws.on("message", (raw) => {
      if (!allow(client)) return send(ws, { type: "reply", id: null, ok: false, code: "RATE_LIMITED", message: "slow down" });
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void handle(client, msg);
    });
    ws.on("close", () => clients.delete(client));
    ws.on("error", () => clients.delete(client));
  });

  async function handle(client: Client, msg: Record<string, unknown>) {
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
          rooms: engine.roomsView(),
          you: { label: session.label, currency: session.currency, balance: formatMinor(balance), cards: engine.playerCards(session.playerId) },
        });
        return reply({ ok: true });
      }
      const s = client.session;
      if (!s) return reply({ ok: false, code: "UNAUTHORIZED", message: "log in first" });
      const roomId = String(msg.roomId ?? "");
      const cardNumber = Number(msg.card);
      const room = engine.roomsView().find((r) => r.roomId === roomId);
      if (!room) return reply({ ok: false, code: "ROOM_NOT_FOUND", message: "no such room" });
      if (room.currency !== s.currency) {
        return reply({ ok: false, code: "WRONG_MODE", message: room.currency === "DEMO" ? "switch to Demo for this room" : "switch to Real for this room" });
      }

      if (msg.type === "pick") {
        await engine.pickCard({ playerId: s.playerId, label: s.label, roomId, cardNumber });
        return reply({ ok: true });
      }
      if (msg.type === "release") {
        engine.releaseCard({ playerId: s.playerId, roomId, cardNumber });
        return reply({ ok: true });
      }
      if (msg.type === "claim") {
        const r = engine.claim({ playerId: s.playerId, roomId, cardNumber });
        return reply({ ok: true, valid: r.valid, pattern: r.pattern });
      }
      reply({ ok: false, code: "UNKNOWN", message: "unknown message type" });
    } catch (err) {
      if (err instanceof BingoError) return reply({ ok: false, code: err.code, message: err.message });
      console.error("[bingo ws]", err);
      reply({ ok: false, code: "INTERNAL", message: "something went wrong" });
    }
  }

  engine.on((event: BingoEvent) => {
    if (event.type === "settlement:failed") return;
    if (event.type === "balance") {
      for (const c of clients) {
        if (c.session?.playerId === event.playerId && c.session.currency === event.currency) {
          send(c.ws, { type: "balance", currency: event.currency, balance: formatMinor(BigInt(event.balance)) });
        }
      }
      return;
    }
    if (event.type === "bingo:card") {
      const { playerId, ...rest } = event;
      for (const c of clients) if (c.session?.playerId === playerId) send(c.ws, rest);
      return;
    }
    const payload = JSON.stringify(event);
    for (const c of clients) if (c.ws.readyState === c.ws.OPEN) c.ws.send(payload);
  });

  return {
    wss,
    close() {
      for (const c of clients) c.ws.terminate();
      wss.close();
    },
  };
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
