// A federated peer rings its visitor back (#75), over the tie line it is
// already connected to rather than over HTTP to a relay that has never heard
// of the handle.
//
//   seat (browser) ⇄ hub (real startServer: SeatRegistry + Switchboard)
//                   ⇄ tie line (real startTieline, hosted INSIDE the peer's relay)
//                   ⇄ peer relay (real startServer) ⇄ stub bridge
//
// The only stub is the peer's bridge. Both relays are real, the trunk is a
// real socket, and the seat handle is minted by the hub's own registry — which
// is the entire point: a peer's relay cannot resolve that handle, so the
// placement has to leave the building.
//
// Spec: docs/superpowers/specs/2026-08-29-federated-callback-design.md

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { SeatRegistry } from "../src/seats.ts";
import { answerSessionLookup } from "./fake-bridge.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

function fastConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.mode = "fast";
  return c;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

function askSeat(ws: WebSocket): void {
  ws.send(encodeEnvelope({
    v: 1, session: "seat-client", seq: 0, kind: "control", link: "seat",
    payload: "SEAT?", eom: true,
  }));
}

function seatControl(ws: WebSocket, payload: string): void {
  ws.send(encodeEnvelope({
    v: 1, session: "seat-client", seq: 0, kind: "control", link: "seat",
    payload, eom: true,
  }));
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function httpJson(
  method: string, url: string, body?: string, headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(),
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Watch one of the console streams for the duration of a test. The operator's
 *  log IS the deliverable for a failed callback (#75: the worst property of the
 *  old behaviour was that it said nothing anywhere), so it gets asserted on. */
function captureConsole(stream: "error" | "log"): { lines: string[]; restore: () => void } {
  const original = console[stream];
  const lines: string[] = [];
  console[stream] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console[stream] = original; } };
}

interface StubConn { session: string; frames: string[] }
interface StubBridge {
  port: number;
  posts: Array<{ surface: string; internalToken?: string; session: string }>;
  conns: StubConn[];
  close: () => Promise<void>;
}

/** The peer's bridge. Mints a fresh session per POST (so the visitor's session
 *  and the callback's `trunk-caller` session are distinguishable), records
 *  every frame per connection, and — for a `trunk-caller` session only —
 *  greets on connect, the way a real fresh Joshua session does. */
async function startStubBridge(): Promise<StubBridge> {
  const posts: StubBridge["posts"] = [];
  const conns: StubConn[] = [];
  const surfaceOf = new Map<string, string>();
  let n = 0;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        const body = Buffer.concat(chunks).toString();
        const surface = (JSON.parse(body || "{}") as { surface?: string }).surface ?? "";
        const session = `S${++n}`;
        surfaceOf.set(session, surface);
        posts.push({
          surface, session,
          internalToken: req.headers["x-wopr-internal-token"] as string | undefined,
        });
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: session, token: `T-${session}` }));
        return;
      }
      // The lookup a `/link` dial makes before it paces anything (#80): this
      // bridge minted these sessions, so it is the one that says what they are.
      if (answerSessionLookup(req, res, (id) => surfaceOf.get(id))) return;
      res.writeHead(500);
      res.end();
    });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!(req.url ?? "").startsWith("/ws/session/")) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws, req) => {
    const session = (req.url ?? "").split("/ws/session/")[1]?.split("?")[0] ?? "";
    const conn: StubConn = { session, frames: [] };
    conns.push(conn);
    ws.on("message", (data) => { conn.frames.push(data.toString()); });
    if (surfaceOf.get(session) === "trunk-caller") {
      ws.send(encodeEnvelope({
        v: 1, session, seq: 0, kind: "output", link: "off",
        payload: "GREETINGS PROFESSOR FALKEN", eom: true,
      }));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    port: (server.address() as { port: number }).port,
    posts, conns,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

/** The one ORIGIN a leg was told, if any. */
function originOf(conn: StubConn | undefined): string | undefined {
  for (const raw of conn?.frames ?? []) {
    let e: Envelope;
    try { e = decodeEnvelope(raw); } catch { continue; }
    if (e.kind === "control" && e.payload.startsWith("ORIGIN seat ")) {
      return e.payload.slice("ORIGIN seat ".length);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------

test("a peer rings its visitor back over its own tie line", { timeout: 30_000 }, async () => {
  const bridge = await startStubBridge();
  const registry = new SeatRegistry();
  // The hub relays and holds seats; its own bridgeUrl points at a closed port
  // on purpose, so a stray local /link fails loudly rather than borrowing the
  // peer's bridge. No seeded world: this hub is not the flagship.
  const hub = await startServer({
    port: 0, config: fastConfig(), publicBase: "http://hub.invalid",
    bridgeUrl: "ws://127.0.0.1:9", trunk: { reservedWorlds: [] },
    seats: { registry },
  });

  let announce!: (code: string) => void;
  const assigned = new Promise<string>((resolve) => { announce = resolve; });
  // The peer: a relay that hosts its own tie line, exactly as `make host`
  // starts it. Nothing here is a hub — no seeded local world, and its
  // switchboard stays empty for the whole test.
  const peer = await startServer({
    port: 0, config: fastConfig(),
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    internalToken: "peer-secret",
    tieline: {
      hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
      name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period",
      world: 1, slot: "PANAM", reconnect: false,
      onAssigned: (code) => announce(code),
    },
  });

  try {
    const exchange = await assigned;

    // The visitor mints a session on the PEER's bridge, through the hub's REST
    // relay — the ordinary way a relayed visitor gets one.
    const post = await httpJson(
      "POST", `http://127.0.0.1:${hub.port}/x/${exchange}/api/session`,
      JSON.stringify({ surface: "home-terminal" }));
    assert.equal(post.status, 201);
    const { session_id, token } = JSON.parse(post.body) as { session_id: string; token: string };

    // David's desk holds a seat — at the HUB, which is where seats live.
    const seat = await connect(`ws://127.0.0.1:${hub.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const seatToken = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];
    const seatId = registry.byToken(seatToken)!.id;
    // Collected, not awaited one at a time: the RING is sent synchronously
    // inside placeCall, so it lands BEFORE the 201 that told us to look for it.
    const seatSaid: Envelope[] = [];
    seat.on("message", (data) => {
      try { seatSaid.push(decodeEnvelope(data.toString())); } catch { /* not ours */ }
    });

    // ... and dials the peer, carrying it.
    const visitor = new WebSocket(
      `ws://127.0.0.1:${hub.port}/x/${exchange}/link` +
      `?surface=home-terminal&session=${session_id}&token=${encodeURIComponent(token)}` +
      `&seat=${seatToken}`);

    // The handle the HUB minted, against the PEER's exchange code, reaches the
    // PEER's program as an ordinary ORIGIN envelope. Before this piece the
    // trunk dropped it on the floor: the hub strips `seat=` from the relayed
    // query (a foreign host must never see the token), and nothing else
    // carried the handle across.
    await waitFor(() => originOf(bridge.conns.find((c) => c.session === session_id)) !== undefined);
    const handle = originOf(bridge.conns.find((c) => c.session === session_id))!;
    assert.match(handle, /^\S+$/);

    // The token itself never crossed. Only the handle did.
    assert.ok(!JSON.stringify(bridge.conns).includes(seatToken),
      "the seat token is the one credential a foreign host must never see");

    // A relayed handle is one-shot: a second dial on the same session is told
    // nothing, so a stale entry cannot re-arm a callback for a call that ended.
    const second = await connect(
      `ws://127.0.0.1:${peer.port}/link?surface=home-terminal&session=${session_id}&token=X`);
    await waitFor(() => bridge.conns.filter((c) => c.session === session_id).length === 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(originOf(bridge.conns.filter((c) => c.session === session_id)[1]), undefined,
      "a relayed handle is consumed by the leg it was registered for, once");
    second.close();

    // The hangup is the trigger to dial: until the visitor lets go, the hub
    // refuses to ring a seat it is holding.
    visitor.close();
    await waitFor(() => registry.leg(seatId)?.onCall === false);

    // What the peer's bridge does at hangup: post the handle to its OWN relay.
    const placed = await httpJson(
      "POST", `http://127.0.0.1:${peer.port}/trunk/place`,
      JSON.stringify({ seat: handle }),
      { "x-wopr-internal-token": "peer-secret", "content-type": "application/json" });
    assert.equal(placed.status, 201, `expected a placement, got ${placed.body}`);
    assert.equal(typeof JSON.parse(placed.body).chan, "number");

    // The seat rings, and it is the PEER's exchange calling — not the hub's.
    await waitFor(() => seatSaid.some((e) => e.kind === "control" && e.payload.startsWith("RING ")));
    assert.equal(seatSaid.find((e) => e.kind === "control")!.payload, "RING BASEMENT EXCH");

    // The program on the other end is the peer's own: the callback's session
    // was minted on the peer's bridge, on the caller surface, with the peer's
    // own internal token.
    await waitFor(() => bridge.posts.some((p) => p.surface === "trunk-caller"));
    const caller = bridge.posts.find((p) => p.surface === "trunk-caller")!;
    assert.equal(caller.internalToken, "peer-secret");

    // Answering lets through the words the caller already spoke — a fresh
    // session on the PEER's bridge greeting the moment it connected, which is
    // the film's line falling out of the machinery rather than being scripted.
    seatControl(seat, "ANSWER");
    await waitFor(() => seatSaid.some((e) => e.kind === "output" && e.eom));
    assert.equal(reassemble(seatSaid.filter((e) => e.kind === "output"))[0],
                 "GREETINGS PROFESSOR FALKEN");

    seat.close();
  } finally {
    await peer.close();
    await hub.close();
    await bridge.close();
  }
});

test("a peer whose tie line is down refuses the callback loudly", async () => {
  const errors = captureConsole("error");
  let peer: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    // Port 9 (discard) is closed here: the tie line never comes up.
    peer = await startServer({
      port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9",
      internalToken: "peer-secret",
      tieline: {
        hubUrl: "ws://127.0.0.1:9/trunk", name: "BASEMENT EXCH",
        region: "PORTLAND US", joshua: "period", reconnect: false,
      },
    });
    assert.ok(peer.tieline, "a configured relay must hold a tie line");

    const r = await httpJson(
      "POST", `http://127.0.0.1:${peer.port}/trunk/place`,
      JSON.stringify({ seat: "whatever" }),
      { "x-wopr-internal-token": "peer-secret", "content-type": "application/json" });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).refused, "offline");
    assert.ok(errors.lines.some((l) => l.includes("CALLBACK NOT PLACED — TIE LINE DOWN")),
      `expected a loud line; got ${JSON.stringify(errors.lines)}`);
  } finally {
    errors.restore();
    await peer?.close();
  }
});

test("a relay with neither a tie line nor a seeded world says so rather than nothing", async () => {
  const errors = captureConsole("error");
  const relay = await startServer({
    port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9",
    internalToken: "peer-secret",
  });
  try {
    assert.equal(relay.tieline, undefined);
    const r = await httpJson(
      "POST", `http://127.0.0.1:${relay.port}/trunk/place`,
      JSON.stringify({ seat: "whatever" }),
      { "x-wopr-internal-token": "peer-secret", "content-type": "application/json" });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).refused, "offline");
    assert.ok(errors.lines.some((l) => l.includes("CALLBACK NOT PLACED — NO TRUNK")),
      `expected a loud line; got ${JSON.stringify(errors.lines)}`);
  } finally {
    errors.restore();
    await relay.close();
  }
});

test("a hub is never a peer: a seeded relay refuses to dial a tie line", async () => {
  const errors = captureConsole("error");
  const hub = await startServer({
    port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9",
    internalToken: "hub-secret",
    trunk: {
      reservedWorlds: [],
      localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR" }],
    },
    // A stray TRUNK_HUB_URL in a hub's environment would otherwise have it
    // dial ITSELF and route its own callbacks out through that loop.
    tieline: {
      hubUrl: "ws://127.0.0.1:9/trunk", name: "CHEYENNE MOUNTAIN",
      region: "SAO PAULO BR", joshua: "period", reconnect: false,
    },
  });
  try {
    assert.equal(hub.tieline, undefined, "a seeded relay must not hold a tie line");
    assert.ok(errors.lines.some((l) => l.includes("TIE LINE IGNORED")),
      `expected a loud line; got ${JSON.stringify(errors.lines)}`);

    // And the flagship path is untouched: the placement went to the local
    // switchboard, which refused the unknown handle the way it always has.
    const r = await httpJson(
      "POST", `http://127.0.0.1:${hub.port}/trunk/place`,
      JSON.stringify({ seat: "whatever" }),
      { "x-wopr-internal-token": "hub-secret", "content-type": "application/json" });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.body).refused, "seat-gone");
  } finally {
    errors.restore();
    await hub.close();
  }
});
