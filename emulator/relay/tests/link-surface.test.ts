// `/link` paces a session by the surface the BRIDGE stored for it (#80).
//
// The query string says which surface a dial claims to be; until this suite
// existed nothing ever compared that claim to the session. A visitor could
// mint an ordinary `home-terminal` session — which needs no token, and must
// not, it is the front door — and then dial
// `/link?surface=trunk-caller&session=…` to be paced at profile `off`: baud 0,
// no shaping, which for the `claude` engine is also the only thing bounding
// token spend per connection. #74/#79 closed the MINT; this is the dial.
//
// The fake bridge below is deliberately faithful rather than convenient: it
// mints whatever surface is asked for, requires the internal token for the two
// machine surfaces exactly as the real one does since #79, remembers what it
// minted, and reports it back on `GET /api/session/{id}`. So the first test
// performs the actual attack rather than a model of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { type RunningServer } from "../src/server.ts";
import { startServer, LOOPBACK } from "./loopback.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const INTERNAL_SURFACES = new Set(["trunk-call", "trunk-caller"]);

interface FakeBridge {
  port: number;
  /** Every REST request this bridge answered, in order. */
  requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
  /** How many upstream `/ws/session/…` sockets a relay has opened. On `main`
   *  the attack below opens one; the whole point of the fix is that it
   *  never gets that far. */
  upstreams: number;
  /** Resolves the first time a relay opens an upstream socket. */
  nextUpstream: () => Promise<void>;
  close: () => Promise<void>;
}

/** `fail: "lookup"` answers 500 to the session lookup while still minting —
 *  a bridge whose HTTP face is broken, which must not become a dial.
 *  `lookupDelayMs` holds the lookup open, which is how a test lands a visitor
 *  hang-up inside the window the lookup opened. */
function fakeBridge(opts: { internalToken?: string; fail?: "lookup";
                            lookupDelayMs?: number } = {}): Promise<FakeBridge> {
  const surfaces = new Map<string, string>();
  const requests: FakeBridge["requests"] = [];
  let upstreams = 0;
  let announceUpstream: (() => void) | undefined;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = req.url ?? "";
      requests.push({ method: req.method ?? "", path, headers: req.headers });

      if (req.method === "POST" && path === "/api/session") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { surface?: string };
        const surface = body.surface ?? "";
        // #79, reproduced: the two machine surfaces are internal-only.
        if (INTERNAL_SURFACES.has(surface)
            && req.headers["x-wopr-internal-token"] !== opts.internalToken) {
          res.writeHead(401); res.end(); return;
        }
        const id = `session-${surfaces.size + 1}`;
        surfaces.set(id, surface);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: id, token: `token-for-${id}`, surface }));
        return;
      }

      const lookup = /^\/api\/session\/([^/?]+)$/.exec(path);
      if (req.method === "GET" && lookup) {
        const answer = () => {
          if (opts.fail === "lookup") { res.writeHead(500); res.end(); return; }
          const surface = surfaces.get(decodeURIComponent(lookup[1]!));
          if (surface === undefined) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ surface, defcon: 5, link_profile: "x", room_code: null,
                                   system: null, last_seen_at: null }));
        };
        if (opts.lookupDelayMs) setTimeout(answer, opts.lookupDelayMs);
        else answer();
        return;
      }

      res.writeHead(500); res.end();
    });
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", () => { upstreams += 1; announceUpstream?.(); });

  return new Promise((resolve) => {
    server.listen(0, LOOPBACK, () => resolve({
      port: (server.address() as { port: number }).port,
      requests,
      get upstreams() { return upstreams; },
      nextUpstream: () => new Promise<void>((done) => {
        if (upstreams > 0) { done(); return; }
        announceUpstream = done;
      }),
      close: () => new Promise<void>((done) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => done());
      }),
    }));
  });
}

function mint(bridgePort: number, surface: string, token?: string):
    Promise<{ status: number; session_id?: string; token?: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers["x-wopr-internal-token"] = token;
    const req = http.request(`http://127.0.0.1:${bridgePort}/api/session`,
                             { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode ?? 0, ...(body ? JSON.parse(body) : {}) });
      });
    });
    req.on("error", reject);
    req.end(JSON.stringify({ surface }));
  });
}

type Closed = { kind: "close"; code: number; reason: string };

function closed(ws: WebSocket, timeoutMs = 8_000): Promise<Closed> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the line was never closed")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ kind: "close", code, reason: reason.toString() });
    });
    ws.once("error", () => { /* a refused line can surface as an error too */ });
  });
}

/** Whichever comes first: the relay closing the line, or the relay opening an
 *  upstream socket to the bridge. A refused dial must never reach the bridge,
 *  so a test that only waited for a close would hang on the unfixed code
 *  instead of failing with something legible. */
function closeOrUpstream(ws: WebSocket, bridge: FakeBridge): Promise<Closed | { kind: "upstream" }> {
  return Promise.race([
    closed(ws),
    bridge.nextUpstream().then(() => ({ kind: "upstream" as const })),
  ]);
}

async function relay(bridge: FakeBridge, internalToken = ""): Promise<RunningServer> {
  return startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    internalToken,
    // The claim, not the ritual, is under test.
    config: { ...DEFAULT_CONFIG, mode: "fast" },
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });
}

function dial(server: RunningServer, surface: string, session: string, token = "t"): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}/link?surface=${encodeURIComponent(surface)}`
                       + `&session=${encodeURIComponent(session)}&token=${encodeURIComponent(token)}`);
}

// -- the attack -------------------------------------------------------------

test("a visitor cannot dial as a machine: the surface must be the session's (#80)", async () => {
  const bridge = await fakeBridge({ internalToken: "SECRET" });
  const server = await relay(bridge, "SECRET");
  try {
    // Step one, and it must keep working: an ordinary front-door session,
    // minted by a stranger with no credential of any kind.
    const visitor = await mint(bridge.port, "home-terminal");
    assert.equal(visitor.status, 201, "the front door must mint for anyone");

    // Step two, the hole: claim the machine surface at the dial instead.
    const ws = dial(server, "trunk-caller", visitor.session_id!, visitor.token!);
    try {
      assert.deepEqual(await closeOrUpstream(ws, bridge), {
        kind: "close", code: 4403, reason: "surface does not match session",
      }, "a dial claiming a surface that is not the session's must be refused, "
       + "not paced at the profile it asked for");
      // And refused BEFORE the bridge is troubled with a session socket.
      assert.equal(bridge.upstreams, 0);
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

test("the refusal is not special to the trunk: any surface but the session's is refused", async () => {
  // `norad-bigboard` is not an escalation — anyone may mint one — but it is
  // still a claim about a session that is not true, and the relay must not
  // silently pace by it.
  const bridge = await fakeBridge();
  const server = await relay(bridge);
  try {
    const visitor = await mint(bridge.port, "home-terminal");
    const ws = dial(server, "norad-bigboard", visitor.session_id!, visitor.token!);
    try {
      assert.deepEqual(await closeOrUpstream(ws, bridge), {
        kind: "close", code: 4403, reason: "surface does not match session",
      });
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

// -- what must keep working -------------------------------------------------

test("an honest visitor dial connects, and the relay asked the bridge about it", async () => {
  const bridge = await fakeBridge();
  const server = await relay(bridge);
  try {
    const visitor = await mint(bridge.port, "home-terminal");
    const ws = dial(server, "home-terminal", visitor.session_id!, visitor.token!);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
      });
      await bridge.nextUpstream();
      assert.equal(bridge.upstreams, 1, "the honest dial reaches the bridge as before");
      assert.ok(
        bridge.requests.some((r) => r.method === "GET"
                                 && r.path === `/api/session/${visitor.session_id}`),
        `the relay must look the session up; saw ${JSON.stringify(bridge.requests.map((r) => r.method + " " + r.path))}`,
      );
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

test("a machine leg still dials its own surface: openLocalLeg's path is unchanged", async () => {
  // The `trunk-caller` end of a machine call mints WITH the token (#79) and
  // then dials `?surface=trunk-caller`. That claim is true, so it connects —
  // a fix that broke this would take every machine call down (#72, #85).
  const bridge = await fakeBridge({ internalToken: "SECRET" });
  const server = await relay(bridge, "SECRET");
  try {
    const leg = await mint(bridge.port, "trunk-caller", "SECRET");
    assert.equal(leg.status, 201);
    const ws = dial(server, "trunk-caller", leg.session_id!, leg.token!);
    try {
      await bridge.nextUpstream();
      assert.equal(bridge.upstreams, 1);
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

// -- the ways a lookup can fail ---------------------------------------------

test("a session the bridge has never heard of is refused 4404", async () => {
  const bridge = await fakeBridge();
  const server = await relay(bridge);
  try {
    const ws = dial(server, "home-terminal", "11111111-1111-1111-1111-111111111111");
    try {
      assert.deepEqual(await closeOrUpstream(ws, bridge),
                       { kind: "close", code: 4404, reason: "unknown session" });
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

test("a bridge that cannot answer the lookup fails CLOSED, 4503", async () => {
  // Fail-open here would mean an outage of the bridge's HTTP face silently
  // disables the control while its WebSocket face keeps working — the same
  // shape as the fail-open mint that was #74.
  const bridge = await fakeBridge({ fail: "lookup" });
  const server = await relay(bridge);
  try {
    const visitor = await mint(bridge.port, "home-terminal");
    const ws = dial(server, "home-terminal", visitor.session_id!, visitor.token!);
    try {
      assert.deepEqual(await closeOrUpstream(ws, bridge),
                       { kind: "close", code: 4503, reason: "session lookup failed" });
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

test("a bridge that is not there at all fails closed too", async () => {
  const bridge = await fakeBridge();
  const server = await startServer({
    port: 0,
    bridgeUrl: "ws://127.0.0.1:9",           // a closed port, on purpose
    config: { ...DEFAULT_CONFIG, mode: "fast" },
    handshake: { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  });
  try {
    const ws = dial(server, "home-terminal", "11111111-1111-1111-1111-111111111111");
    try {
      const seen = await closed(ws);
      assert.equal(seen.code, 4503, seen.reason);
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

// -- what must NOT reach the bridge -----------------------------------------

test("a surface this relay does not know is still 4400, with no request made", async () => {
  const bridge = await fakeBridge();
  const server = await relay(bridge);
  try {
    const ws = dial(server, "not-a-surface", "11111111-1111-1111-1111-111111111111");
    try {
      const seen = await closed(ws);
      assert.equal(seen.code, 4400);
      assert.deepEqual(bridge.requests, [],
                       "a claim that could never be honoured must not become a bridge request");
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

test("a dial with no session at all is still 4400, with no request made", async () => {
  const bridge = await fakeBridge();
  const server = await relay(bridge);
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/link?surface=home-terminal`);
    try {
      const seen = await closed(ws);
      assert.equal(seen.code, 4400);
      assert.deepEqual(bridge.requests, []);
    } finally { ws.close(); }
  } finally { await server.close(); await bridge.close(); }
});

// -- how the lookup identifies itself ---------------------------------------

test("the lookup carries the internal token when the relay has one, and no header when it does not",
     async () => {
  for (const token of ["SECRET", ""]) {
    const bridge = await fakeBridge({ internalToken: "SECRET" });
    const server = await relay(bridge, token);
    try {
      const visitor = await mint(bridge.port, "home-terminal");
      const ws = dial(server, "home-terminal", visitor.session_id!, visitor.token!);
      try {
        await bridge.nextUpstream();
        const lookup = bridge.requests.find((r) => r.method === "GET");
        assert.ok(lookup, "no lookup was made");
        // Sent because the relay already sends it to this host on the session
        // socket, and so the bridge stays free to restrict the endpoint later.
        // Empty means OMITTED, never a blank header — an unconfigured relay
        // must read as "no header", not as "wrong token".
        assert.equal(lookup.headers["x-wopr-internal-token"], token || undefined);
      } finally { ws.close(); }
    } finally { await server.close(); await bridge.close(); }
  }
});

// -- the window the lookup opened -------------------------------------------

test("a visitor who hangs up during the lookup leaves no upstream socket behind", async () => {
  // The handler used to be synchronous, so a client `close` could only ever
  // arrive after its listeners were wired. The lookup opens a window where it
  // can arrive first — and a leg that goes on to dial for a client that is
  // already gone opens an upstream socket with nothing left to tear it down:
  // teardown() has already run and is once-only. Hang up, dial again, and a
  // visitor leaks one bridge session per connect.
  //
  // The ritual is deliberately real here (authentic, lightly scaled) because
  // the window is the ritual: `runHandshake` is 6-9 seconds in production, and
  // the hang-up lands inside it.
  const bridge = await fakeBridge({ lookupDelayMs: 200 });
  const server = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    config: structuredClone(DEFAULT_CONFIG),      // authentic: the dial takes time
    handshake: { timeScale: 0.05, rng: () => 0.5, failRate: 0 },
  });
  try {
    const visitor = await mint(bridge.port, "home-terminal");
    const ws = dial(server, "home-terminal", visitor.session_id!, visitor.token!);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.close();                                     // ... while the lookup is in flight
    await new Promise((r) => setTimeout(r, 2_000)); // past the lookup and the ritual behind it
    assert.equal(bridge.upstreams, 0,
                 "a leg must not dial upstream for a client that has already gone");
  } finally { await server.close(); await bridge.close(); }
});
