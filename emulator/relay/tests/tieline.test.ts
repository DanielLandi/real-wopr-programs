// Tieline client tests (trunk-federation spec, Task 3). The tieline is the
// host side of TRUNK/1: one outbound socket to the hub, one local WebSocket
// per relayed call, an allowlisted local REST relay. The hub can only ever
// reach the two configured local endpoints (localComms, localBridge) — never
// anywhere else, even if it tries.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { startServer } from "../src/server.ts";
import { startTieline } from "../src/tieline.ts";

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

function httpJson(
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Stub local comms: echoes every text frame straight back, byte-identical —
// enough to prove the tieline is bridging chan frames to a real local socket
// rather than fabricating a response itself.
async function startStubComms(): Promise<{ port: number; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(data.toString()));
  });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}

// Stub local bridge: only answers the two allowlisted paths this test drives
// with real success bodies. Everything else — including any disallowed path
// a misbehaving tieline might forward — answers 500, so a host-side allowlist
// leak would be visible as a 500 instead of the correct un-forwarded 404.
async function startStubBridge(): Promise<{
  port: number;
  requests: Array<{ method: string; path: string; body: string }>;
  close: () => Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      if (req.method === "POST" && req.url === "/api/session") {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: "s" }));
        return;
      }
      if (req.method === "GET" && req.url === "/api/games") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ games: ["tictactoe"] }));
        return;
      }
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("tieline: registers, relays visitor frames and allowlisted REST to the local stack", async () => {
  const hub = await startServer({ port: 0 });
  const comms = await startStubComms();
  const bridge = await startStubBridge();

  let resolveAssigned!: (exchange: string) => void;
  const assigned = new Promise<string>((resolve) => { resolveAssigned = resolve; });

  const tieline = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "TEST EXCH",
    region: "TESTLAND",
    joshua: "period",
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    reconnect: false,
    onAssigned: (exchange) => resolveAssigned(exchange),
  });

  try {
    const code = await assigned;
    const base = `http://127.0.0.1:${hub.port}`;
    const wsBase = `ws://127.0.0.1:${hub.port}`;

    // Visitor round trip through the hub relay -> tieline -> stub comms echo -> back.
    const visitor = await connect(`${wsBase}/x/${code}/link?surface=home-terminal&session=s&token=t`);
    const echoPromise = nextMessage(visitor);
    visitor.send("HELLO FROM VISITOR");
    assert.equal(await echoPromise, "HELLO FROM VISITOR");
    visitor.close();

    // REST relay: POST /api/session round-trips to the stub bridge's 201.
    const postResp = await httpJson("POST", `${base}/x/${code}/api/session`, JSON.stringify({ hello: "world" }));
    assert.equal(postResp.status, 201);
    assert.deepEqual(JSON.parse(postResp.body), { session_id: "s" });

    // REST relay: GET /api/games round-trips to the stub bridge's 200.
    const getResp = await httpJson("GET", `${base}/x/${code}/api/games`);
    assert.equal(getResp.status, 200);
    assert.deepEqual(JSON.parse(getResp.body), { games: ["tictactoe"] });
  } finally {
    tieline.stop();
    await hub.close();
    await comms.close();
    await bridge.close();
  }
});

test("tieline: a refused hub connection is logged, not swallowed silently", async () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  try {
    // Nothing listens here: the connect errors out immediately.
    const tieline = startTieline({
      hubUrl: "ws://127.0.0.1:1/trunk",
      name: "TEST EXCH",
      region: "TESTLAND",
      joshua: "period",
      localComms: "ws://127.0.0.1:1",
      localBridge: "http://127.0.0.1:1",
      reconnect: false,
    });
    const deadline = Date.now() + 2000;
    while (errors.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    tieline.stop();
    assert.ok(
      errors.some((e) => e.includes("TIE LINE DOWN")),
      `expected a TIE LINE DOWN log, got: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = orig;
  }
});

test("tieline: a disallowed REQUEST path is refused host-side without touching the local bridge", async () => {
  // The real hub already enforces the allowlist before it ever forwards a
  // REQUEST (server.ts checks restAllowed before relaying), so driving this
  // through a real hub's HTTP relay only proves the HUB's enforcement. To
  // prove the HOST enforces independently, a fake hub sends a hand-crafted
  // REQUEST frame for a disallowed path directly over the wire.
  const comms = await startStubComms();
  const bridge = await startStubBridge();

  const fakeHub = new WebSocketServer({ port: 0 });
  const responses: Array<{ t: string; rid: number; status: number; body: string }> = [];
  let resolveResponse!: () => void;
  const gotResponse = new Promise<void>((resolve) => { resolveResponse = resolve; });

  fakeHub.on("connection", (ws) => {
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.t === "REGISTER") {
        ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01" }));
        ws.send(JSON.stringify({ t: "REQUEST", rid: 1, method: "POST", path: "/api/session/1/defcon" }));
      } else if (f.t === "RESPONSE") {
        responses.push(f);
        resolveResponse();
      }
    });
  });
  await new Promise<void>((resolve) => fakeHub.once("listening", resolve));
  const hubPort = (fakeHub.address() as { port: number }).port;

  const tieline = startTieline({
    hubUrl: `ws://127.0.0.1:${hubPort}`,
    name: "TEST EXCH",
    region: "TESTLAND",
    joshua: "period",
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    reconnect: false,
  });

  try {
    await gotResponse;
    assert.equal(responses.length, 1);
    assert.equal(responses[0].t, "RESPONSE");
    assert.equal(responses[0].status, 404);
    assert.equal(bridge.requests.length, 0, "the disallowed path must never reach the local bridge");
  } finally {
    tieline.stop();
    await new Promise<void>((resolve) => fakeHub.close(() => resolve()));
    await comms.close();
    await bridge.close();
  }
});
