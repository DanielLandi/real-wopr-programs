// End-to-end proxy test: fake surface ⇄ comms server ⇄ fake bridge.
// Also the toggle test (§7): flipping COMMS_MODE requires no change in bridge
// or surface code — the same client/bridge code runs under both modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, seededPort, type RunningServer } from "../src/server.ts";
import { DEFAULT_CONFIG, type CommsConfig } from "../src/config.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";
import type { TrunkFrame } from "../src/trunk.ts";
import { SeatRegistry } from "../src/seats.ts";
import { answerSessionLookup, lookupBridge } from "./fake-bridge.ts";

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

/** Reads JSON trunk frames off `ws` until one satisfies `pred`, discarding
 *  any that do not. A test that just closed a channel and is now waiting on
 *  the NEXT call's OPEN cannot assume that OPEN is the very next frame: the
 *  CLOSE from the channel it just tore down is in flight on the same socket
 *  and can land first. Taking `nextMessage` blind races that ordering.
 *
 *  The frames are BUFFERED from the first call on, not taken one `once` at a
 *  time. Two frames that arrive in one TCP read (CLOSE and OPEN, or PLACED
 *  and CLOSE — routine when the process is slow to read under a loaded
 *  parallel run) are parsed by ws in one synchronous loop and emitted as two
 *  back-to-back `message` events, before any microtask runs. A `once`
 *  listener consumes the first, and the second fires into nobody — the frame
 *  this test is waiting for is gone, and the wait never ends (#113). */
const frameQueues = new WeakMap<WebSocket, { frames: any[]; wake: (() => void)[] }>();
async function nextFrame<T = any>(ws: WebSocket, pred: (f: any) => boolean): Promise<T> {
  let q = frameQueues.get(ws);
  if (!q) {
    q = { frames: [], wake: [] };
    frameQueues.set(ws, q);
    const queue = q;
    ws.on("message", (data) => {
      queue.frames.push(JSON.parse(data.toString()));
      for (const w of queue.wake.splice(0)) w();
    });
  }
  for (;;) {
    while (q.frames.length > 0) {
      const f = q.frames.shift();
      if (pred(f)) return f as T;
    }
    await new Promise<void>((r) => q!.wake.push(r));
  }
}

/** A visitor's call to `url`, resolved once BOTH ends know it: the hub's OPEN
 *  has reached `host` and the visitor's socket is open. The OPEN wait is
 *  armed before the socket exists, so the frame cannot land unobserved; the
 *  socket is awaited because the hub sends the OPEN at the upgrade, a round
 *  trip before the visitor's own `open` — a test that closes the dial the
 *  moment the host has seen it can close a socket still CONNECTING, and ws
 *  answers that with an `error` event nobody listens for, which takes the
 *  test down as an uncaught exception (#82). */
async function dial(host: WebSocket, url: string): Promise<{ ws: WebSocket; open: any }> {
  const opened = nextFrame(host, (f) => f.t === "OPEN");
  const ws = await connect(url);
  return { ws, open: await opened };
}

// Sends the seat-leg control handshake: `SEAT?` is answered with `SEAT
// <token>` only in reply, never on connect (see server.ts's seatWss comment)
// — so every test that needs a token asks for one explicitly.
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

/** Poll `check` until it is true or `timeoutMs` elapses. Used to observe an
 *  effect of an already-sent WS frame without racing the server's processing
 *  of it (no ack exists for ANSWER/REJECT — the caller learns of the effect
 *  through a side channel, e.g. a RingHandlers callback). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function httpJson(method: string, url: string, body?: string,
                  headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Stub local bridge: only answers POST /api/session, with a real success
// body — enough for openLocalLeg's mint to succeed. Everything else answers
// 500, so a request that should never happen (a REST path leaking through)
// is visible as a 500 instead of silently succeeding.
//
// `fail: true` makes every /api/session mint refuse (a 500), for testing
// what happens when a mint never gets a session. `delayMs` holds the
// response open for that long — the hook a race test needs to land a CLOSE
// while a mint is still in flight, deterministically rather than by luck.
function startStubBridge(opts?: { fail?: boolean; delayMs?: number }): Promise<{
  port: number;
  requests: Array<{ method: string; path: string; body: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: string; headers: http.IncomingHttpHeaders }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        requests.push({ method: req.method ?? "", path: req.url ?? "", body, headers: req.headers });
        const respond = () => {
          if (req.method === "POST" && req.url === "/api/session" && !opts?.fail) {
            res.writeHead(201, { "content-type": "application/json" });
            res.end(JSON.stringify({ session_id: `s${requests.length}`, token: "t" }));
            return;
          }
          res.writeHead(500);
          res.end();
        };
        if (opts?.delayMs) setTimeout(respond, opts.delayMs);
        else respond();
      });
    });
    server.listen(0, () => {
      resolve({
        port: (server.address() as { port: number }).port,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// Stub local comms: a bare WebSocketServer that echoes every text frame
// straight back — enough for a local leg to have somewhere real to dial and
// stay open, without pulling in the full /link ritual (handshake, shaper,
// upstream bridge) that this file's other tests already cover end to end.
function startStubComms(): Promise<{
  port: number;
  wss: WebSocketServer;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0 });
    wss.on("connection", (ws) => {
      ws.on("message", (data) => ws.send(data.toString()));
    });
    wss.on("listening", () => {
      resolve({
        port: (wss.address() as { port: number }).port,
        wss,
        close: () => new Promise<void>((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(() => r());
        }),
      });
    });
  });
}

/** A minimal fake bridge implementing the WS side of api-contract.md: echoes
 *  every reassembled input back as one output frame.
 *
 *  It answers `GET /api/session/{id}` too, because since #80 a `/link` dial
 *  asks which surface the session is before it paces anything — a bridge that
 *  cannot say refuses the dial `4503`. Every session it is asked about is a
 *  `home-terminal` one: these tests dial with a hand-written id and are about
 *  the ritual, not about who minted what. */
function fakeBridge(): Promise<{ port: number; close: () => void; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const httpServer = http.createServer((req, res) => {
      if (answerSessionLookup(req, res, () => "home-terminal")) return;
      res.writeHead(500);
      res.end();
    });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws, req) => {
      const buffer: Envelope[] = [];
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        buffer.push(e);
        if (e.eom) {
          const [msg] = reassemble(buffer.splice(0));
          seen.push(msg);
          ws.send(encodeEnvelope({
            v: 1, session: e.session, seq: 0, kind: "output",
            link: e.link, payload: `ECHO: ${msg}`, eom: true,
          }));
        }
      });
      void req;
    });
    httpServer.listen(0, () => {
      resolve({
        port: (httpServer.address() as { port: number }).port,
        close: () => { for (const c of wss.clients) c.terminate(); httpServer.close(); },
        seen,
      });
    });
  });
}

async function runSession(mode: "authentic" | "fast"): Promise<{
  handshakes: string[];
  outputs: string[];
}> {
  const bridge = await fakeBridge();
  const config: CommsConfig = structuredClone(DEFAULT_CONFIG);
  config.mode = mode;
  // Keep authentic timings CI-friendly but real.
  config.profiles["dialup-300"] = {
    baud: 9600, bits_per_char: 10, latency_ms: 5, jitter_ms: 2,
    frame_bytes: 16, handshake: "dialup",
  };

  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    internalToken: "test-secret",
    config,
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });

  const handshakes: string[] = [];
  const outputs: string[] = [];
  const pending: Record<string, Envelope[]> = {};

  // This client code is identical for both modes — that IS the toggle test.
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/link?surface=home-terminal&session=11111111-1111-1111-1111-111111111111&token=tk`,
  );

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("session timed out")), 10_000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        // Reassemble per kind: the shaper chunks every payload (§3.3).
        (pending[e.kind] ??= []).push(e);
        if (!e.eom) return;
        const [msg] = reassemble(pending[e.kind].splice(0));
        if (e.kind === "handshake") {
          handshakes.push(msg);
          if (msg.startsWith("CONNECTED")) {
            ws.send(encodeEnvelope({
              v: 1, session: e.session, seq: 0, kind: "input",
              link: e.link, payload: "HELP GAMES", eom: true,
            }));
          }
        }
        if (e.kind === "output") {
          outputs.push(msg);
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on("error", reject);
    });
  } finally {
    ws.close();
    await server.close();
    bridge.close();
  }
  return { handshakes, outputs };
}

test("authentic mode: full ritual, then shaped round-trip through the bridge", async () => {
  const { handshakes, outputs } = await runSession("authentic");
  assert.deepEqual(
    handshakes.map((h) => h.split(" ")[0]),
    ["DIALING", "RINGING", "CARRIER_DETECT", "HANDSHAKE", "CONNECTED"],
  );
  assert.deepEqual(outputs, ["ECHO: HELP GAMES"]);
});

test("toggle: fast mode runs the identical client code, instant connect, same bytes", async () => {
  const { handshakes, outputs } = await runSession("fast");
  assert.deepEqual(handshakes.map((h) => h.split(" ")[0]), ["CONNECTED"]);
  assert.deepEqual(outputs, ["ECHO: HELP GAMES"]);
});

test("redundant control DIAL while connected is ignored (no second upstream socket)", async () => {
  let connections = 0;
  // The fake bridge answers the session lookup as well as the socket: since
  // #80 a `/link` dial asks which surface the session IS before it paces
  // anything, and a bridge that cannot say refuses the dial.
  const bridge = await lookupBridge("home-terminal", () => { connections += 1; });
  const bridgePort = bridge.port;

  const config: CommsConfig = structuredClone(DEFAULT_CONFIG);
  config.mode = "fast";
  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridgePort}`,
    internalToken: "test-secret",
    config,
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });

  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/link?surface=home-terminal&session=11111111-1111-1111-1111-111111111111&token=tk`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no CONNECTED")), 5000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        if (e.kind === "handshake" && e.eom && e.payload.startsWith("CONNECT")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    // Give the upstream socket a beat to open, then send a redundant DIAL.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(connections, 1);
    ws.send(encodeEnvelope({
      v: 1, session: "11111111-1111-1111-1111-111111111111", seq: 0,
      kind: "control", link: "client", payload: "DIAL", eom: true,
    }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(connections, 1, "a redundant DIAL must not open a second upstream");
  } finally {
    ws.close();
    await server.close();
    await bridge.close();
  }
});

test("upstream drop delivers NO CARRIER on the line BEFORE the client socket closes (issue #88)", async () => {
  // A bridge that accepts the session then immediately drops it, reproducing
  // the silent line-drop: the queued NO CARRIER used to die in down.close().
  // Answering the session lookup as well as the socket is what a fake bridge
  // has to do since #80 — see fake-bridge.ts.
  const bridge = await lookupBridge("home-terminal", (ws: WebSocket) => ws.close());
  const bridgePort = bridge.port;

  const config: CommsConfig = structuredClone(DEFAULT_CONFIG);
  config.mode = "fast"; // the drop, not the ritual, is under test
  config.profiles["dialup-300"] = {
    baud: 9600, bits_per_char: 10, latency_ms: 5, jitter_ms: 2,
    frame_bytes: 16, handshake: "dialup",
  };
  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridgePort}`,
    internalToken: "test-secret",
    config,
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });

  // Ordered log of the two line events the surface must observe, in order.
  const events: string[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/link?surface=home-terminal&session=11111111-1111-1111-1111-111111111111&token=tk`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no close observed")), 5000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        if (e.kind === "control" && e.payload === "NO CARRIER") {
          events.push("no-carrier");
        }
      });
      ws.on("close", () => {
        events.push("close");
        clearTimeout(timeout);
        resolve();
      });
      ws.on("error", reject);
    });
    assert.deepEqual(
      events,
      ["no-carrier", "close"],
      "the surface must receive a control NO CARRIER frame before the WS close",
    );
  } finally {
    ws.close();
    await server.close();
    await bridge.close();
  }
});

test("a system's parting words survive the close at 300 baud (issue #62)", async () => {
  // The node's DROP path sends the sign-off display and closes the socket
  // immediately behind it. At authentic baud that display is still trickling
  // through the downstream shaper when the upstream close lands — and
  // teardown()'s down.close() used to discard the whole paced queue, so the
  // visitor saw the line drop with no parting words at all.
  const display = "\nPANAMAC OFF\n";
  const bridge = await lookupBridge("home-terminal", (ws: WebSocket) => {
    ws.send(encodeEnvelope({
      v: 1, session: "s", seq: 0, kind: "output",
      link: "dialup-300", payload: display, eom: true,
    }));
    ws.close();
  });
  const bridgePort = bridge.port;

  // The real 300-baud line: ~30 chars/s, so this display takes ~0.4s to reach
  // the surface — far longer than the close takes to arrive behind it.
  const config: CommsConfig = structuredClone(DEFAULT_CONFIG);
  config.mode = "authentic";
  config.profiles["dialup-600"] = { ...DEFAULT_CONFIG.profiles["dialup-300"] };

  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridgePort}`,
    internalToken: "test-secret",
    config,
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });

  const events: string[] = [];
  const outputs: Envelope[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${server.port}/link?surface=home-terminal&session=22222222-2222-2222-2222-222222222222&token=tk`,
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no close observed")), 10_000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        if (e.kind === "output") { outputs.push(e); events.push("output"); }
        if (e.kind === "control" && e.payload === "NO CARRIER") events.push("no-carrier");
      });
      ws.on("close", () => {
        events.push("close");
        clearTimeout(timeout);
        resolve();
      });
      ws.on("error", reject);
    });

    assert.equal(reassemble(outputs).join(""), display,
      "the sign-off display must reach the surface before the line drops");
    assert.equal(events.at(-1), "close");
    assert.equal(events.at(-2), "no-carrier",
      "NO CARRIER is the last thing on the line, after the parting words");
    assert.ok(events.indexOf("output") < events.indexOf("no-carrier"),
      `the display must precede the carrier drop: ${events.join(",")}`);
  } finally {
    ws.close();
    await server.close();
    await bridge.close();
  }
});

// ---- the hub's own seeded port, and POST /trunk/place (Task 5) -----------

test("trunk/place: refuses without the internal token", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }));
    assert.equal(res.status, 401);
  } finally { await server.close(); }
});

test("trunk/place: answers the refusal reason rather than an error", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }), { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body), { refused: "offline" });
  } finally { await server.close(); }
});

test("trunk/place: a successful placement mints a session for the placer, not only the callee", async () => {
  // Switchboard.placeCall sends an OPEN only to the target — the placer's own
  // end is an internal peerPort with nothing to talk to a program. Without
  // the route calling seededPort's attach() after a successful placeCall, the
  // flagship could dial out and then have nothing to say on the line.
  const bridge = await startStubBridge();
  const server = await startServer({
    port: 0, internalToken: "SECRET", bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    trunk: { localWorld: [
      { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
      { slot: "PANAM", name: "PAN AM", region: "NEW YORK US" },
    ] },
  });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }), { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 201);
    const parsed = JSON.parse(res.body) as { chan: number };
    assert.equal(typeof parsed.chan, "number");

    // Both mints fire off the same event-loop turn placeCall returns in —
    // poll rather than a fixed sleep, since which of the two lands first on
    // the stub bridge is not something this test should assume.
    const deadline = Date.now() + 3000;
    let mints: typeof bridge.requests = [];
    while (Date.now() < deadline) {
      mints = bridge.requests.filter((r) => r.path === "/api/session");
      if (mints.length >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(mints.length, 2,
      "both the callee (PANAM) and the placer (WOPR) must mint a session");
    const surfaces = mints
      .map((m) => (JSON.parse(m.body) as { surface: string }).surface)
      .sort();
    // The answering end paces (trunk-call); the placer must not (trunk-caller)
    // — never a shaping profile on the end that placed the call.
    assert.deepEqual(surfaces, ["trunk-call", "trunk-caller"]);
  } finally {
    await server.close();
    await bridge.close();
  }
});

// ---- seededPort unit coverage (fix round 1): PING/REQUEST, the double-fire
// close guard, mid-mint CLOSE cancellation, and a refused mint's CLOSE ------
//
// seededPort is exported specifically so these can be tested directly,
// the way local-leg.test.ts tests openLocalLeg directly — a seeded slot's
// internal exchange code is never exposed on any public interface (the
// directory deliberately omits it, see trunk.ts's `directory()`), so PING
// and REQUEST in particular have no route in through startServer's HTTP/WS
// surface at all.

test("seededPort: PING answers PONG", () => {
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    "ws://127.0.0.1:1", "ws://127.0.0.1:1", (f) => up.push(f),
  );
  port.send(JSON.stringify({ t: "PING" }));
  assert.deepEqual(up, [{ t: "PONG" }]);
});

test("seededPort: REQUEST answers 404 promptly, never Switchboard.request()'s timeout", () => {
  // A seeded slot has no REST host behind it — the hub synthesizes its
  // directory entry itself — so nothing should ever wait on one.
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    "ws://127.0.0.1:1", "ws://127.0.0.1:1", (f) => up.push(f),
  );
  port.send(JSON.stringify({ t: "REQUEST", rid: 42, method: "GET", path: "/api/games" }));
  assert.deepEqual(up, [{ t: "RESPONSE", rid: 42, status: 404, body: "{}" }]);
});

test("seededPort: a refused mint frees the channel with an explicit CLOSE", async () => {
  // openLocalLeg's own `close` callback fires before the mint even resolves
  // ("no session"), with nothing yet registered under `legs` for the guard
  // to find — so without an explicit CLOSE from the `.then()` branch here,
  // Exchange.channels keeps this chan forever (sweepDead skips seeded
  // exchanges; nothing else reaps them).
  const bridge = await startStubBridge({ fail: true });
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    `ws://127.0.0.1:${bridge.port}`,
    "ws://127.0.0.1:1", // never dialled: the mint fails before any /link attempt
    (f) => up.push(f),
  );
  try {
    port.send(JSON.stringify({ t: "OPEN", chan: 3, query: "", origin: { world: 1, slot: "PANAM" } }));
    const deadline = Date.now() + 2000;
    while (up.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(up, [{ t: "CLOSE", chan: 3, reason: "no session" }]);
  } finally {
    port.close();
    await bridge.close();
  }
});

test("seededPort: the mint carries the internal token (#74)", async () => {
  // The bridge refuses a TRUNK surface to a caller that cannot prove it is
  // the relay, so a hub whose seeded slots do not forward the token places
  // calls that all refuse with `no session`. Three call sites share
  // openLocalLeg; this is the one that lives inside the hub itself.
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    `ws://127.0.0.1:${bridge.port}`,
    `ws://127.0.0.1:${comms.port}`,
    (f) => up.push(f),
    "SECRET",
  );
  try {
    port.send(JSON.stringify({ t: "OPEN", chan: 5, query: "", origin: { world: 1, slot: "PANAM" } }));
    const deadline = Date.now() + 2000;
    while (bridge.requests.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const mint = bridge.requests.find((r) => r.path === "/api/session");
    assert.ok(mint, "the OPEN must have minted a session");
    assert.equal(mint.headers["x-wopr-internal-token"], "SECRET");
  } finally {
    port.close();
    await comms.close();
    await bridge.close();
  }
});

test("seededPort: a CLOSE that arrives while a machine call's mint is in flight does not leak the leg", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge({ delayMs: 200 });
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    `ws://127.0.0.1:${bridge.port}`,
    `ws://127.0.0.1:${comms.port}`,
    (f) => up.push(f),
  );
  try {
    port.send(JSON.stringify({ t: "OPEN", chan: 7, query: "", origin: { world: 1, slot: "PANAM" } }));
    // Well inside the 200ms mint delay: the session POST has not resolved yet.
    await new Promise((r) => setTimeout(r, 50));
    port.send(JSON.stringify({ t: "CLOSE", chan: 7 }));
    // Past the mint delay: the leg has now resolved, found itself abandoned,
    // and must have closed rather than registering under chan 7 or sending
    // anything else upstream.
    await new Promise((r) => setTimeout(r, 350));
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "the race requires the mint to actually complete");
    assert.deepEqual(up, [], "an abandoned mint must not send anything upstream");
    // A live (leaked) leg would deliver this to the echoing stub comms and
    // relay the echo back as an upstream FRAME. An abandoned leg has nothing
    // registered under chan 7 to deliver to.
    port.send(JSON.stringify({ t: "FRAME", chan: 7, data: "PING" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(up, []);
  } finally {
    port.close();
    await comms.close();
    await bridge.close();
  }
});

test("seededPort: a leg that errors as well as closes still sends exactly one CLOSE upstream", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const up: TrunkFrame[] = [];
  const port = seededPort(
    { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
    `ws://127.0.0.1:${bridge.port}`,
    `ws://127.0.0.1:${comms.port}`,
    (f) => up.push(f),
  );
  // Break the underlying connection with an invalid WS frame once it opens:
  // openLocalLeg binds the SAME `close` callback to both the socket's
  // "close" and "error" events, so a real protocol failure fires it twice
  // for one call — the guard this test exists for.
  comms.wss.on("connection", (ws) => {
    setTimeout(() => {
      (ws as unknown as { _socket: { write(b: Buffer): void } })._socket.write(Buffer.from([0x8f, 0x00]));
    }, 100);
  });
  try {
    port.send(JSON.stringify({ t: "OPEN", chan: 9, query: "", origin: { world: 1, slot: "PANAM" } }));
    const deadline = Date.now() + 3000;
    while (!up.some((f) => f.t === "CLOSE") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // Give a would-be second CLOSE from the same double-fire every chance to
    // also land before asserting there is only one.
    await new Promise((r) => setTimeout(r, 300));
    const closes = up.filter((f) => f.t === "CLOSE" && f.chan === 9);
    assert.equal(closes.length, 1, `expected exactly one CLOSE, got ${JSON.stringify(up)}`);
  } finally {
    port.close();
    await comms.close();
    await bridge.close();
  }
});

// ---- POST /trunk/place: a null body must not kill the hub process --------

test("trunk/place: a null body answers 400 instead of an unhandled rejection", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  const unhandled: unknown[] = [];
  const onUnhandled = (err: unknown) => unhandled.push(err);
  process.on("unhandledRejection", onUnhandled);
  try {
    // JSON.parse("null") succeeds — `want` would be `null`, and reading
    // `want.seat` throws a TypeError OUTSIDE the parse's try/catch. handleHttp
    // is fired as `void handleHttp(req, res)` (see server.ts), so an escaping
    // throw here becomes an unhandled rejection and, unguarded, takes down
    // the whole hub process — the one that also serves production /link.
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      "null", { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 400);
    // Give any escaping rejection a chance to be reported before asserting.
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(unhandled, [], "a null body must not escape as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    await server.close();
  }
});

// ---- bonus coverage for Important 1 (fail-closed auth) and Important 2
// (bounded body) — not in the required list, but cheap and directly tied to
// the fixed code paths.

test("trunk/place: with no internal token configured, the route is invisible (404)", async () => {
  const server = await startServer({ port: 0,
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }));
    assert.equal(res.status, 404);
  } finally { await server.close(); }
});

test("trunk/place: an oversize body is rejected with 413, not buffered without bound", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const big = JSON.stringify({ slot: "PANAM", junk: "x".repeat(5000) });
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      big, { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 413);
  } finally { await server.close(); }
});

// ---- /seat: the endpoint a terminal holds for the life of its session ----

test("seat: a leg is told its token in reply to SEAT?", async () => {
  const server = await startServer({ port: 0 });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(ws);
    const e = decodeEnvelope(await nextMessage(ws));
    assert.equal(e.kind, "control");
    assert.match(e.payload, /^SEAT \S+$/);
    ws.close();
  } finally { await server.close(); }
});

test("seat: a repeated SEAT? is idempotent — same token, no second leg", async () => {
  const registry = new SeatRegistry();
  const server = await startServer({ port: 0, seats: { registry } });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(ws);
    const first = decodeEnvelope(await nextMessage(ws)).payload;
    assert.equal(registry.size, 1);

    askSeat(ws);
    const second = decodeEnvelope(await nextMessage(ws)).payload;
    assert.equal(second, first, "a repeated SEAT? must return the SAME token");
    assert.equal(registry.size, 1, "a repeated SEAT? must not mint a second leg");
    ws.close();
  } finally { await server.close(); }
});

test("seat: an unknown surface is refused", async () => {
  const server = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/seat?surface=nope`);
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));
    assert.equal(code, 4400);
  } finally { await server.close(); }
});

test("seat: the cap refuses once every slot is taken", async () => {
  const server = await startServer({ port: 0, seats: { maxSeats: 1 } });
  try {
    const first = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(first);
    const e = decodeEnvelope(await nextMessage(first));
    assert.match(e.payload, /^SEAT \S+$/, "the first seat must be granted");

    const second = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(second);
    const code = await new Promise<number>((resolve) => second.once("close", resolve));
    assert.equal(code, 4429);
    first.close();
  } finally { await server.close(); }
});

test("seat: an un-minted socket is closed after the handshake timeout", async () => {
  const server = await startServer({ port: 0, seats: { handshakeTimeoutMs: 50 } });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    // Deliberately never sends SEAT? — this socket must not be held open
    // forever. Bounded against a plain timeout, not just the close event: if
    // the guard regresses, the socket is simply never closed, which would
    // otherwise hang this test instead of failing it.
    const code = await Promise.race([
      new Promise<number>((resolve) => ws.once("close", resolve)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("socket was never closed")), 2000)),
    ]);
    assert.equal(code, 4408);
  } finally { await server.close(); }
});

test("seat: pending (un-minted) sockets count toward the cap", async () => {
  const server = await startServer({ port: 0, seats: { maxSeats: 1 } });
  try {
    // Connects, but deliberately never sends SEAT? — held open, un-minted.
    const pending = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);

    const second = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(second);
    // Race close against message rather than only awaiting close: if the cap
    // wrongly ignores the pending socket, `second` gets granted a SEAT and
    // is never closed, which would otherwise hang this test forever instead
    // of failing it.
    const outcome = await Promise.race([
      new Promise<{ kind: "close"; code: number }>((resolve) =>
        second.once("close", (code) => resolve({ kind: "close", code }))),
      new Promise<{ kind: "message"; payload: string }>((resolve) =>
        second.once("message", (data) =>
          resolve({ kind: "message", payload: decodeEnvelope(data.toString()).payload }))),
    ]);
    assert.deepEqual(outcome, { kind: "close", code: 4429 },
      "a pending, un-minted socket must count toward maxSeats, not only a minted one");

    // Releasing the pending slot (by closing it) must free the cap for the next comer.
    pending.close();
    await new Promise((r) => setTimeout(r, 20));
    const third = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(third);
    const e = decodeEnvelope(await nextMessage(third));
    assert.match(e.payload, /^SEAT \S+$/, "closing the pending socket must release its slot");
    third.close();
  } finally { await server.close(); }
});

test("seat: ANSWER reaches the registry", async () => {
  const registry = new SeatRegistry();
  const server = await startServer({ port: 0, seats: { registry } });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(ws);
    const token = decodeEnvelope(await nextMessage(ws)).payload.split(" ")[1]!;
    const leg = registry.byToken(token);
    assert.ok(leg, "the leg must be registered under its token");

    const events: string[] = [];
    const result = registry.ring(leg!.id, "PAN AM", {
      answered: () => events.push("answered"),
      rejected: () => events.push("rejected"),
      timedOut: () => events.push("timedOut"),
    });
    assert.equal(result, "ringing");
    const ring = decodeEnvelope(await nextMessage(ws));
    assert.equal(ring.payload, "RING PAN AM");

    seatControl(ws, "ANSWER");
    await waitFor(() => events.length > 0);
    assert.deepEqual(events, ["answered"]);
    ws.close();
  } finally { await server.close(); }
});

test("seat: REJECT reaches the registry", async () => {
  const registry = new SeatRegistry();
  const server = await startServer({ port: 0, seats: { registry } });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(ws);
    const token = decodeEnvelope(await nextMessage(ws)).payload.split(" ")[1]!;
    const leg = registry.byToken(token);
    assert.ok(leg, "the leg must be registered under its token");

    const events: string[] = [];
    const result = registry.ring(leg!.id, "PAN AM", {
      answered: () => events.push("answered"),
      rejected: () => events.push("rejected"),
      timedOut: () => events.push("timedOut"),
    });
    assert.equal(result, "ringing");
    await nextMessage(ws); // RING PAN AM

    seatControl(ws, "REJECT");
    await waitFor(() => events.length > 0);
    assert.deepEqual(events, ["rejected"]);
    ws.close();
  } finally { await server.close(); }
});

test("seat: closing the socket tears down the leg", async () => {
  const registry = new SeatRegistry();
  const server = await startServer({ port: 0, seats: { registry } });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(ws);
    const token = decodeEnvelope(await nextMessage(ws)).payload.split(" ")[1]!;
    assert.equal(registry.size, 1);
    assert.ok(registry.byToken(token), "the leg exists while the socket is open");

    ws.close();
    await waitFor(() => registry.size === 0);
    assert.equal(registry.byToken(token), undefined,
      "closing the socket must drop the leg and its token");
  } finally { await server.close(); }
});

test("seat: the token never crosses the trunk", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hub = `ws://127.0.0.1:${server.port}/trunk`;
  const host = await connect(hub);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "A EXCH",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));
    assert.equal(assigned.t, "ASSIGNED");

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const { ws: visitor, open } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    assert.equal(open.t, "OPEN");
    assert.doesNotMatch(open.query, /seat=/,
      "the seat token is the one credential a foreign host must never see");
    assert.ok(!JSON.stringify(open).includes(token), "nor anywhere else in the frame");
    visitor.close(); seat.close();
  } finally { host.close(); await server.close(); }
});

test("seat: a dial carrying a token discloses a handle to the exchange it called", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const { ws: first, open: open1 } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    assert.ok(open1.origin && typeof open1.origin.seat === "string",
      "a machine learns who called by being called");
    first.close();

    // first.close() -> cleanup -> closeChannel sends the host a CLOSE for
    // chan 1, on the same socket the second call's OPEN is about to arrive
    // on. Which lands first is a race this test must not assume the answer
    // to — `dial` drains until the frame is actually an OPEN, discarding a
    // stray CLOSE from the call just torn down (and keeps both if they
    // arrive together).
    const { ws: second, open: open2 } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S2&token=T2&seat=${token}`);
    assert.equal(open2.origin.seat, open1.origin.seat,
      "one seat, one exchange, one handle — across calls");
    second.close(); seat.close();
  } finally { host.close(); await server.close(); }
});

test("seat: a seat's handle for one exchange differs from its handle for another", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hostA = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  const hostB = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    hostA.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const panam = JSON.parse(await nextMessage(hostA));
    hostB.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PROTOVISION",
      region: "SUNNYVALE US", joshua: "period", world: 1, slot: "PROTOVISION" }));
    const proto = JSON.parse(await nextMessage(hostB));

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const { ws: toPanam, open: openPanam } = await dial(hostA,
      `ws://127.0.0.1:${server.port}/x/${panam.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    toPanam.close();

    const { ws: toProto, open: openProto } = await dial(hostB,
      `ws://127.0.0.1:${server.port}/x/${proto.exchange}/link` +
      `?surface=home-terminal&session=S2&token=T2&seat=${token}`);
    toProto.close(); seat.close();

    assert.notEqual(openPanam.origin.seat, openProto.origin.seat,
      "PAN AM and PROTOVISION must hold different handles for the same seat");
  } finally { hostA.close(); hostB.close(); await server.close(); }
});

test("seat: a dial without a token discloses nothing", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));
    const { ws: visitor, open } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1`);
    assert.equal(open.origin, undefined, "a stale tab still gets to phone a machine");
    visitor.close();
  } finally { host.close(); await server.close(); }
});

test("seat: an unknown or dead token discloses nothing, and the dial still succeeds", async () => {
  const registry = new SeatRegistry();
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] }, seats: { registry } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));

    // Unknown: a token this hub never minted at all — not merely absent.
    const { ws: unknown, open: openUnknown } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=not-a-real-token`);
    assert.equal(openUnknown.origin, undefined, "an unknown token discloses nothing");
    unknown.close();

    // Dead: a token that WAS real, but whose seat leg has since closed.
    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1]!;
    seat.close();
    await waitFor(() => registry.byToken(token) === undefined);

    const { ws: dead, open: openDead } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S2&token=T2&seat=${token}`);
    assert.equal(openDead.origin, undefined,
      "a dead token discloses nothing, and a stale tab can still phone a machine");
    dead.close();
  } finally { host.close(); await server.close(); }
});

test("link: a direct dial carrying a token discloses its origin as an ORIGIN control envelope", async () => {
  // The homeSlot limitation (WOPR): a direct /link dial can only ever mint
  // against the hub's own seeded Joshua line, so that seed must exist for
  // this test to see a handle minted at all.
  const bridge = await fakeBridge();
  const config: CommsConfig = structuredClone(DEFAULT_CONFIG);
  config.mode = "fast";
  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    internalToken: "test-secret",
    config,
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] },
  });
  try {
    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const ws = new WebSocket(
      `ws://127.0.0.1:${server.port}/link?surface=home-terminal` +
      `&session=22222222-2222-2222-2222-222222222222&token=tk&seat=${token}`,
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no CONNECTED")), 5000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        if (e.kind === "handshake" && e.eom && e.payload.startsWith("CONNECT")) {
          clearTimeout(timeout);
          resolve();
        }
      });
      ws.on("error", reject);
    });
    await waitFor(() => bridge.seen.length > 0);
    assert.match(bridge.seen[0]!, /^ORIGIN seat \S+$/,
      "a direct dial carrying a token discloses its origin as the first thing the bridge receives");
    ws.close();
    seat.close();
  } finally {
    await server.close();
    bridge.close();
  }
});
// ---- ringing a seat, end to end (worlds phase 2, piece B) -----------------
//
// Fast mode throughout: it collapses the handshake to an instant CONNECTED and
// stops the shaper pacing, so these tests do not sit through a 1200-baud
// playout of every frame. Each holds the registry seam so it can wait on the
// seat's actual state — the hold the handle-minting dial took, the hold an
// answered ring takes — instead of guessing with a wall-clock sleep.

/** A running transcript of everything a socket has said. `nextMessage`'s
 *  one-shot listener cannot be used on the seat leg here: a RING is emitted
 *  the instant the PLACE is processed, which is BEFORE a test that first
 *  awaited the PLACED on the host socket gets to attach a listener — and a ws
 *  message with no listener is gone, not queued. A listener attached once, up
 *  front, misses nothing. */
function transcript(ws: WebSocket) {
  const msgs: string[] = [];
  ws.on("message", (d) => msgs.push(d.toString()));
  return {
    get length() { return msgs.length; },
    /** The n-th thing this socket said (1-based), waited for and decoded. */
    async at(n: number): Promise<Envelope> {
      await waitFor(() => msgs.length >= n);
      return decodeEnvelope(msgs[n - 1]!);
    },
    /** Everything said so far, decoded, in order. */
    all(): Envelope[] { return msgs.map((m) => decodeEnvelope(m)); },
    /** Wait until something said so far satisfies `pred`. */
    until(pred: (e: Envelope) => boolean): Promise<void> {
      return waitFor(() => msgs.some((m) => pred(decodeEnvelope(m))));
    },
  };
}

const isNoCarrier = (e: Envelope) => e.kind === "control" && e.payload === "NO CARRIER";

function ringServer(registry: SeatRegistry): Promise<RunningServer> {
  return startServer({ port: 0, config: { ...DEFAULT_CONFIG, mode: "fast" },
                       trunk: { reservedWorlds: [] }, seats: { registry } });
}

function registerPanAm(host: WebSocket): void {
  host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
    region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
}

function machineSays(chan: number, payload: string): string {
  return JSON.stringify({ t: "FRAME", chan,
    data: encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "output",
      link: "trunk-caller", payload, eom: true }) });
}

/** Open a seat, let it dial PAN AM once — which is how PAN AM earns a handle
 *  for it — and hang that dial up again. Returns the handle PAN AM now holds,
 *  the seat socket, its leg id, and the seat's transcript. */
async function seatThatCalled(server: RunningServer, host: WebSocket, registry: SeatRegistry) {
  const assigned = JSON.parse(await nextMessage(host));
  const exchange: string = assigned.exchange;
  const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
  askSeat(seat);
  const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1]!;
  const id = registry.byToken(token)!.id;
  const said = transcript(seat);

  const { ws: call, open } = await dial(host,
    `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
    `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
  const handle: string = open.origin.seat;
  call.close();
  // The dial held the seat for as long as it was up. Wait for that hold to be
  // released rather than sleeping on it: until it is, the seat is busy for a
  // legitimate reason and the ring under test would be refused.
  await waitFor(() => registry.leg(id)?.onCall === false);
  return { handle, seat, id, said, token, exchange };
}

test("ring: a machine rings a seat that called it, and the seat answers", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, said } = await seatThatCalled(server, host, registry);

    // Now PAN AM calls back.
    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED" || f.t === "REFUSED");
    assert.equal(placed.t, "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // The calling program greets the moment it connects — before anyone has
    // answered. The PLACE that follows is a barrier: frames on one socket are
    // processed in order, so a REFUSED for it proves the hub has already
    // handled the greeting, and the seat still has not seen it.
    host.send(machineSays(placed.chan, "GREETINGS PROFESSOR FALKEN"));
    host.send(JSON.stringify({ t: "PLACE", call: 2, to: { seat: "NOT-A-HANDLE" } }));
    const refused = await nextFrame(host, (f) => f.t === "REFUSED");
    assert.equal(refused.reason, "seat-gone");
    assert.equal(said.length, 1, "nothing crosses an unanswered line");

    seatControl(seat, "ANSWER");
    assert.equal((await said.at(2)).payload, "GREETINGS PROFESSOR FALKEN",
      "and the first words are not lost");

    // ...and the seat can talk back, up the same channel.
    seat.send(encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "input",
      link: "seat", payload: "HELLO", eom: true }));
    const back = await nextFrame(host, (f) => f.t === "FRAME");
    assert.equal(back.chan, placed.chan);
    assert.equal(decodeEnvelope(back.data).payload, "HELLO");
    seat.close();
  } finally { host.close(); await server.close(); }
});

test("ring: a rejected ring closes the caller's channel", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED" || f.t === "REFUSED");
    assert.equal(placed.t, "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "REJECT");
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.chan, placed.chan);
    assert.equal(closed.reason, "rejected");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// Declining a call and being told the carrier dropped is wrong on the wire and
// wrong in the fiction: nothing ever carried (#78 item 2). NO CARRIER is a
// result code for a connection that existed and stopped; a ring that never
// became a call gets NO ANSWER, which is what `end()` has always called it
// upstream. The word cannot simply be dropped: a seat socket stays open across
// a call by design, so this is the ONLY thing that can tell a terminal sitting
// at ANSWER? (Y/N) that the ring is over.
test("ring: a declined ring says NO ANSWER, never NO CARRIER", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // The CLOSE first: `nextFrame` reads what arrives AFTER it is called, and
    // the hub sends the machine's CLOSE before it plays the seat's line out.
    seatControl(seat, "REJECT");
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.reason, "rejected");
    assert.equal((await said.at(2)).payload, "NO ANSWER");
    assert.ok(!said.all().some(isNoCarrier),
      "nothing carried, so nothing may claim the carrier dropped");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// The other unanswered exit the registry owns. Same reasoning, and it is the
// one that proves the terminal is not left at a dead Y/N prompt: the timer
// fires with nobody having touched the seat at all.
test("ring: a ring nobody answers says NO ANSWER when the timer fires", async () => {
  // The registry's ring timer, shortened rather than waited out: 30s is the
  // production value and this test is about the word on the wire, not the wait.
  const registry = new SeatRegistry({ ringTimeoutMs: 200 });
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // Nobody touches the seat at all — this is the case that would otherwise
    // leave the terminal at a dead ANSWER? (Y/N) prompt for ever.
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.chan, placed.chan);
    assert.equal(closed.reason, "no answer");
    assert.equal((await said.at(2)).payload, "NO ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === false);
    seat.close();
  } finally { host.close(); await server.close(); }
});

// An answered ring takes a hold on the seat, and nothing but the bridge ever
// releases it: without that release a seat that answers one call is busy for
// the rest of its life and can never be rung again.
test("ring: an answered call that ends frees the seat to be rung again", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const first = await nextFrame(host, (f) => f.t === "PLACED" || f.t === "REFUSED");
    assert.equal(first.t, "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === true);

    // PAN AM hangs up. The seat is told the carrier dropped, and the seat's
    // hold must end with the call.
    host.send(JSON.stringify({ t: "CLOSE", chan: first.chan, reason: "goodbye" }));
    assert.equal((await said.at(2)).payload, "NO CARRIER");
    await waitFor(() => registry.leg(id)?.onCall === false);

    host.send(JSON.stringify({ t: "PLACE", call: 2, to: { seat: handle } }));
    const second = await nextFrame(host, (f) => f.t === "PLACED" || f.t === "REFUSED");
    assert.equal(second.t, "PLACED", "a seat that answered once must be ringable again");
    assert.equal((await said.at(3)).payload, "RING PAN AM");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// The same hold, released through the other door: the machine's own trunk
// going away ends the call just as surely as it hanging up politely.
test("ring: a dropped trunk frees the seat it was talking to", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  let seat: WebSocket | undefined;
  try {
    registerPanAm(host);
    const called = await seatThatCalled(server, host, registry);
    seat = called.seat;

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: called.handle } }));
    await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await called.said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "ANSWER");
    await waitFor(() => registry.leg(called.id)?.onCall === true);

    host.close();
    await waitFor(() => registry.leg(called.id)?.onCall === false);
  } finally { seat?.close(); host.close(); await server.close(); }
});

// The third door, and the one nothing else watches: `seats.close()` notifies a
// PENDING ring (it fires timedOut), but an ANSWERED call has no such
// notification. Without the bridge ending the wire itself, the machine would
// hold a channel to a departed seat until its own timeout.
test("ring: a seat leaving mid-call closes the machine's channel", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === true);

    seat.close();
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.chan, placed.chan);
    assert.equal(closed.reason, "seat gone");
  } finally { host.close(); await server.close(); }
});

// ---- fix round 1: the doors that were left open ---------------------------

// The sharpest of them. `seats.ring` arms `leg.ring` and a 30s timer; a caller
// that hangs up mid-ring used to leave both armed. The seat went on ringing for
// a caller that was gone and was "busy" to everyone else for the window — and
// if the visitor pressed ANSWER inside it, `answer()` took a hold that the
// bridge's already-latched `end` could never release, so the seat was busy for
// the life of its socket. Place-and-CLOSE on a loop is a cheap denial of
// service against any seat whose handle an exchange holds.
test("ring: a caller that hangs up mid-ring disarms the ring", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // PAN AM gives up before anyone picks up.
    host.send(JSON.stringify({ t: "CLOSE", chan: placed.chan, reason: "gave up" }));
    assert.equal((await said.at(2)).payload, "NO ANSWER",
      "the seat must be told to stop ringing — but nothing carried, so not NO CARRIER");
    await waitFor(() => registry.leg(id)?.onCall === false);

    // The visitor presses ANSWER inside the window the stale ring used to
    // leave open. There is no call to answer, so it must take no hold. `SEAT?`
    // is the barrier: it is answered on the SAME socket, behind the ANSWER.
    seatControl(seat, "ANSWER");
    askSeat(seat);
    assert.match((await said.at(3)).payload, /^SEAT \S+$/);
    assert.equal(registry.leg(id)?.onCall, false, "a stale ANSWER must take no hold");

    // And the seat is genuinely ringable again, not merely reported idle.
    host.send(JSON.stringify({ t: "PLACE", call: 2, to: { seat: handle } }));
    const again = await nextFrame(host, (f) => f.t === "PLACED" || f.t === "REFUSED");
    assert.equal(again.t, "PLACED", "an abandoned ring must not leave the seat busy");
    assert.equal((await said.at(4)).payload, "RING PAN AM");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// Issue #62 on the seat leg. The machine's last line is still trickling through
// the shaper when it hangs up; closing in front of the playout swallows it.
test("ring: a machine's parting words reach the seat before the carrier drops", async () => {
  const display = "PANAMAC OFF LINE. GOODBYE.";
  const registry = new SeatRegistry();
  // Authentic, not fast: at 600 baud (home-terminal) this display takes ~0.4s
  // to trickle out, which is the whole point — the CLOSE lands behind it.
  const server = await startServer({ port: 0,
    config: { ...DEFAULT_CONFIG, mode: "authentic" },
    trunk: { reservedWorlds: [] }, seats: { registry } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === true);

    // Sign off and hang up immediately behind it, the way a node's DROP does.
    host.send(machineSays(placed.chan, display));
    host.send(JSON.stringify({ t: "CLOSE", chan: placed.chan, reason: "goodbye" }));

    await said.until(isNoCarrier);
    const said_ = said.all();
    const carrier = said_.findIndex(isNoCarrier);
    assert.equal(carrier, said_.length - 1,
      "NO CARRIER is the last thing on the line, after the parting words");
    assert.equal(reassemble(said_.slice(0, carrier).filter((e) => e.kind === "output")).join(""),
      display, "the sign-off must reach the seat before the line drops");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// The `if (answered)` guard on the release, exercised with a SECOND holder
// outstanding — the case an ablation that removes the release entirely cannot
// see. Holds are a counter: a visitor mid-ring can dial a machine from the
// same terminal, and an unconditional release on REJECT would free a seat that
// is genuinely mid-conversation.
test("ring: rejecting a ring does not free a seat that is dialling out", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  let outbound: WebSocket | undefined;
  try {
    registerPanAm(host);
    const { handle, seat, id, said, token, exchange } =
      await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // Mid-ring, the visitor dials out from the same terminal. That is a
    // second, independent hold on the seat.
    ({ ws: outbound } = await dial(host,
      `ws://127.0.0.1:${server.port}/x/${exchange}/link` +
      `?surface=home-terminal&session=S9&token=T9&seat=${token}`));
    await waitFor(() => registry.leg(id)?.onCall === true);

    seatControl(seat, "REJECT");
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.reason, "rejected");
    assert.equal(registry.leg(id)?.onCall, true,
      "the outbound dial still holds this seat; the ring never held it at all");

    outbound.close();
    await waitFor(() => registry.leg(id)?.onCall === false);
    seat.close();
  } finally { outbound?.close(); host.close(); await server.close(); }
});

// Control is the seat leg's own vocabulary — what the hub and the terminal say
// to each other about the line. A visitor must not be able to put a line-state
// word into a machine's stream.
test("ring: a seat cannot inject control words into the machine's stream", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");
    seatControl(seat, "ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === true);

    // Two forgeries and then an honest word, in that order on one socket: what
    // the machine sees first tells us which of them crossed.
    seatControl(seat, "NO CARRIER");
    seatControl(seat, "DIAL");
    seat.send(encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "input",
      link: "seat", payload: "HELLO", eom: true }));
    const back = await nextFrame(host, (f) => f.t === "FRAME");
    assert.equal(back.chan, placed.chan);
    assert.equal(decodeEnvelope(back.data).payload, "HELLO",
      "the control words must stop at the hub");
    seat.close();
  } finally { host.close(); await server.close(); }
});

// Holding the caller's first words is the point; holding an unbounded stream of
// them is a hole. maxChannels and the per-frame cap bound the COUNT of frames a
// hostile exchange can park on a ringing line, not the total bytes.
test("ring: a caller that floods an unanswered line is hung up on", async () => {
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, id, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // Nobody has answered. Park frames at close to the per-frame cap on the
    // held line until the hub stops taking them.
    const big = "X".repeat(4000);
    for (let i = 0; i < 12; i++) host.send(machineSays(placed.chan, big));

    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.chan, placed.chan);
    assert.equal(closed.reason, "greeting exceeds hold capacity");
    // ...and the seat, which never answered, is left free rather than ringing.
    assert.equal((await said.at(2)).payload, "NO ANSWER");
    await waitFor(() => registry.leg(id)?.onCall === false);
    seat.close();
  } finally { host.close(); await server.close(); }
});

// ---- the home slot is one value, not three (fix wave) --------------------

/** A bridge with BOTH faces on one port: the HTTP `POST /api/session` a
 *  seeded slot's mint goes through, and the WS session socket a `/link` dial
 *  connects upstream to. `fakeBridge` has only the second, `startStubBridge`
 *  only the first — a test that drives a direct dial AND a seeded placement
 *  needs both at the one `bridgeUrl` the server is given. */
function fullBridge(): Promise<{
  port: number; seen: string[]; sessions: string[]; close: () => Promise<void>;
}> {
  const seen: string[] = [];
  const sessions: string[] = [];
  // What each minted id's surface is, for the lookup a `/link` dial makes
  // before it paces (#80). A session id it never minted — the direct dials in
  // these tests write their own — reads as `home-terminal`, the surface those
  // dials claim.
  const minted = new Map<string, string>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        const body = Buffer.concat(chunks).toString();
        sessions.push(body);
        const id = `s${sessions.length}`;
        minted.set(id, (JSON.parse(body || "{}") as { surface?: string }).surface ?? "");
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: id, token: "t" }));
        return;
      }
      if (answerSessionLookup(req, res, (id) => minted.get(id) ?? "home-terminal")) return;
      res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    const buffer: Envelope[] = [];
    ws.on("message", (data) => {
      const e = decodeEnvelope(data.toString());
      buffer.push(e);
      if (e.eom) seen.push(reassemble(buffer.splice(0))[0]!);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve({
      port: (server.address() as { port: number }).port,
      seen,
      sessions,
      close: () => new Promise<void>((done) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => done());
      }),
    }));
  });
}

test("seats: a non-default homeSlot mints, places and attaches as the SAME exchange",
     { timeout: 15_000 }, async () => {
  // Three sites used to derive the home slot independently: the handle a
  // direct /link dial mints (seededCode(homeSlot)), the exchange
  // POST /trunk/place places as, and which seeded port keeps the attach()
  // reference. Configure anything but the default and they disagreed —
  // handles scoped to SCHOOL's exchange, every placement presenting WOPR's
  // code — and because a handle another exchange holds is refused exactly
  // like an unknown one, the operator saw nothing but `seat-gone` forever.
  const registry = new SeatRegistry();
  const bridge = await fullBridge();
  const server = await startServer({
    port: 0,
    internalToken: "SECRET",
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    config: { ...DEFAULT_CONFIG, mode: "fast" },
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
    // WOPR is seeded too, deliberately: the bug is not "the default slot is
    // missing", it is that the default slot is used INSTEAD of the configured
    // one. With WOPR present the unfixed code places successfully as WOPR and
    // is refused by resolve() — the exact failure the operator sees.
    trunk: { localWorld: [
      { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
      { slot: "SCHOOL", name: "SEATTLE SCHOOL", region: "SEATTLE US" },
    ] },
    seats: { registry, homeSlot: "SCHOOL" },
  });
  try {
    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    askSeat(seat);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1]!;
    const id = registry.byToken(token)!.id;
    const said = transcript(seat);

    // A direct dial carrying the token is what mints the handle. Which
    // exchange it is scoped to is the whole question.
    const dial = new WebSocket(
      `ws://127.0.0.1:${server.port}/link?surface=home-terminal` +
      `&session=22222222-2222-2222-2222-222222222222&token=tk&seat=${token}`);
    await waitFor(() => bridge.seen.some((m) => m.startsWith("ORIGIN seat ")));
    const handle = bridge.seen.find((m) => m.startsWith("ORIGIN seat "))!.split(" ")[2]!;
    dial.close();
    // The dial held the seat while it was up; a ring would be refused "busy"
    // until that hold is released, so wait for it rather than sleeping.
    await waitFor(() => registry.leg(id)?.onCall === false);

    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ seat: handle }), { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 201,
      `the configured home slot must present the code its own handles were minted against: ${res.body}`);

    // The seat is actually rung, by the exchange that placed.
    const ring = await said.at(1);
    assert.equal(ring.payload, "RING SEATTLE SCHOOL");

    // ...and the placer's own end got a local leg, which only happens if the
    // seeded port kept under `homePort` is the one that placed.
    await waitFor(() => bridge.sessions.some(
      (b) => (JSON.parse(b) as { surface: string }).surface === "trunk-caller"));

    seat.close();
  } finally {
    await server.close();
    await bridge.close();
  }
});

test("ring: a seat leaving mid-RING ends the call as 'seat gone', through the no-playout door", async () => {
  // `drop` used to call `seats.close(id)` first, which ends a PENDING ring via
  // the registry's `timedOut()` — reporting "no answer" and draining a playout
  // into a seat that has gone. `endSeatCall` first takes the door the bridge
  // documents as reserved for exactly this case.
  const registry = new SeatRegistry();
  const server = await ringServer(registry);
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    registerPanAm(host);
    const { handle, seat, said } = await seatThatCalled(server, host, registry);

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = await nextFrame(host, (f) => f.t === "PLACED");
    assert.equal((await said.at(1)).payload, "RING PAN AM");

    // Nobody picks up; the terminal goes away instead.
    seat.close();
    const closed = await nextFrame(host, (f) => f.t === "CLOSE");
    assert.equal(closed.chan, placed.chan);
    assert.equal(closed.reason, "seat gone",
      "a seat that left is not a caller who went unanswered");
  } finally { host.close(); await server.close(); }
});
