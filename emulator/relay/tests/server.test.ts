// End-to-end proxy test: fake surface ⇄ comms server ⇄ fake bridge.
// Also the toggle test (§7): flipping COMMS_MODE requires no change in bridge
// or surface code — the same client/bridge code runs under both modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, seededPort } from "../src/server.ts";
import { DEFAULT_CONFIG, type CommsConfig } from "../src/config.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";
import type { TrunkFrame } from "../src/trunk.ts";

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
  requests: Array<{ method: string; path: string; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        requests.push({ method: req.method ?? "", path: req.url ?? "", body });
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
 *  every reassembled input back as one output frame. */
function fakeBridge(): Promise<{ port: number; close: () => void; seen: string[] }> {
  return new Promise((resolve) => {
    const seen: string[] = [];
    const wss = new WebSocketServer({ port: 0 });
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
    wss.on("listening", () => {
      resolve({
        port: (wss.address() as { port: number }).port,
        close: () => wss.close(),
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
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", () => { connections += 1; });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const bridgePort = (wss.address() as { port: number }).port;

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
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test("upstream drop delivers NO CARRIER on the line BEFORE the client socket closes (issue #88)", async () => {
  // A bridge that accepts the session then immediately drops it, reproducing
  // the silent line-drop: the queued NO CARRIER used to die in down.close().
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => ws.close());
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const bridgePort = (wss.address() as { port: number }).port;

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
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});

test("a system's parting words survive the close at 300 baud (issue #62)", async () => {
  // The node's DROP path sends the sign-off display and closes the socket
  // immediately behind it. At authentic baud that display is still trickling
  // through the downstream shaper when the upstream close lands — and
  // teardown()'s down.close() used to discard the whole paced queue, so the
  // visitor saw the line drop with no parting words at all.
  const display = "\nPANAMAC OFF\n";
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.send(encodeEnvelope({
      v: 1, session: "s", seq: 0, kind: "output",
      link: "dialup-300", payload: display, eom: true,
    }));
    ws.close();
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const bridgePort = (wss.address() as { port: number }).port;

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
    await new Promise<void>((resolve) => wss.close(() => resolve()));
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
