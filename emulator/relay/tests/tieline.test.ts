// Tieline client tests (trunk-federation spec, Task 3). The tieline is the
// host side of TRUNK/1: one outbound socket to the hub, one local WebSocket
// per relayed call, an allowlisted local REST relay. The hub can only ever
// reach the two configured local endpoints (localComms, localBridge) — never
// anywhere else, even if it tries.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { startServer } from "../src/server.ts";
import { startTieline } from "../src/tieline.ts";
import { encodeEnvelope } from "../src/envelope.ts";

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
async function startStubComms(): Promise<{
  port: number; onDial?: (url: string) => void; close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0 });
  const self = {
    port: 0,
    onDial: undefined as ((url: string) => void) | undefined,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
  wss.on("connection", (ws, req) => {
    self.onDial?.(req.url ?? "");
    ws.on("message", (data) => ws.send(data.toString()));
  });
  await new Promise<void>((r) => wss.once("listening", r));
  self.port = (wss.address() as { port: number }).port;
  return self;
}

// Stub local bridge: only answers the two allowlisted paths this test drives
// with real success bodies. Everything else — including any disallowed path
// a misbehaving tieline might forward — answers 500, so a host-side allowlist
// leak would be visible as a 500 instead of the correct un-forwarded 404.
async function startStubBridge(opts?: {
  // Delays the /api/session response — the hook a race test needs to hold a
  // mint open long enough to fire a CLOSE while it is still in flight.
  sessionDelayMs?: number;
}): Promise<{
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
        const respond = () => {
          res.writeHead(201, { "content-type": "application/json" });
          res.end(JSON.stringify({ session_id: "s" }));
        };
        if (opts?.sessionDelayMs) setTimeout(respond, opts.sessionDelayMs);
        else respond();
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
        ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 1, slot: "WOPR" }));
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

test("tieline: registers its slot/world and reports the placement", { timeout: 10_000 }, async () => {
  // The placement is the hub's answer, not the host's request: the tieline
  // asks for a slot and a world, and learns where it actually landed from
  // ASSIGNED. "NEW" on an empty board lands in world 2 — world 1 is pinned
  // live (and, on a default hub, reserved), so a host asking for a fresh
  // world skips it either way.
  const hub = await startServer({ port: 0 });
  let resolvePlacement!: (p: { world: number; slot: string }) => void;
  const placement = new Promise<{ world: number; slot: string }>((resolve) => { resolvePlacement = resolve; });

  const tieline = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "BASEMENT EXCH",
    region: "PORTLAND US",
    joshua: "period",
    slot: "SCHOOL",
    world: "NEW",
    // Nothing listens on port 9; this test never opens a call or a REST relay.
    localComms: "ws://127.0.0.1:9",
    localBridge: "http://127.0.0.1:9",
    reconnect: false,
    onAssigned: (_exchange, world, slot) => resolvePlacement({ world, slot }),
  });

  try {
    assert.deepEqual(await placement, { world: 2, slot: "SCHOOL" });
    const dir = await httpJson("GET", `http://127.0.0.1:${hub.port}/trunk/directory`);
    const worlds = JSON.parse(dir.body).worlds as Array<{ n: number; slots: Array<{ slot: string; name: string }> }>;
    assert.deepEqual(
      worlds.flatMap((w) => w.slots.map((s) => [w.n, s.slot, s.name])),
      [[2, "SCHOOL", "BASEMENT EXCH"]],
    );
  } finally {
    tieline.stop();
    await hub.close();
  }
});

test("tieline: stops (no reconnect) when the hub cannot read the REGISTER", { timeout: 20_000 }, async () => {
  // A typo'd slot or world never becomes a refusal — the hub cannot decode the
  // frame at all and closes 4400. That verdict is deterministic, so it has to
  // be as terminal as 4460/4461: redialling re-sends the same bad frame every
  // backoff, forever, with nothing on the console to explain the silence.
  // (The CLI validates these fields first; this is the path where something
  // else builds the opts, and the last line of defence for the operator.)
  const hub = await startServer({ port: 0, trunk: { maxWorlds: 2 } });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const rejections = () => errors.filter((e) => e.includes("LINE NOT ACCEPTED"));

  const typo = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "TYPO EXCH", region: "PORTLAND US", joshua: "period",
    slot: "WOPRR",                                    // off the roster
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    reconnect: true,                                  // the 4400 must override
    onAssigned: () => { assert.fail("a malformed REGISTER must not be assigned"); },
  });

  try {
    const deadline = Date.now() + 3_000;
    while (rejections().length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(rejections(), [
      "LINE NOT ACCEPTED — MALFORMED TRUNK FRAME — CHECK TIELINE_SLOT AND TIELINE_WORLD",
    ]);
    // The first backoff is 5s: wait past it. A tieline that treated 4400 as an
    // outage would be on its second (and third...) attempt by now, each one
    // logging again.
    await new Promise((r) => setTimeout(r, 6_500));
    assert.equal(rejections().length, 1, `redialled a frame the hub cannot read: ${JSON.stringify(errors)}`);
    const dir = await httpJson("GET", `http://127.0.0.1:${hub.port}/trunk/directory`);
    const worlds = JSON.parse(dir.body).worlds as Array<{ slots: unknown[] }>;
    assert.deepEqual(worlds.flatMap((w) => w.slots), []);   // nothing was ever placed
  } finally {
    console.error = origError;
    typo.stop();
    await hub.close();
  }
});

test("tieline: a 4400 AFTER the placement is an outage, not a verdict", { timeout: 20_000 }, async () => {
  // The hub closes 4400 for ANY frame it cannot decode, not only a REGISTER —
  // server.ts does it on every host message. So a single corrupt frame on a
  // trunk the hub already placed arrives here as the same close code as a
  // typo'd slot. Treating it as terminal would take a LIVE exchange off the
  // board for good, blaming TIELINE_SLOT/TIELINE_WORLD, which were fine.
  // Once ASSIGNED has arrived, 4400 follows the ordinary backoff retry.
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  let connections = 0;
  const fakeHub = new WebSocketServer({ port: 0 });
  fakeHub.on("connection", (ws) => {
    connections += 1;
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).t !== "REGISTER") return;
      // Placed — and then the hub chokes on something mid-stream.
      ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 2, slot: "WOPR" }));
      setTimeout(() => ws.close(4400, "malformed trunk frame"), 20);
    });
  });
  await new Promise<void>((resolve) => fakeHub.once("listening", resolve));
  const hubPort = (fakeHub.address() as { port: number }).port;

  let assignedCalls = 0;
  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${hubPort}`,
    name: "LIVE EXCH", region: "PORTLAND US", joshua: "period",
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    reconnect: true,
    onAssigned: () => { assignedCalls += 1; },
  });

  try {
    // The first backoff is 5s: past it, a tieline that respected the retry path
    // has redialled and been placed a second time.
    const deadline = Date.now() + 12_000;
    while (connections < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(connections >= 2, `a post-ASSIGNED 4400 killed a live trunk: ${connections} connection(s)`);
    assert.ok(assignedCalls >= 2, `the redial was never placed again: ${assignedCalls} ASSIGNED`);
    assert.deepEqual(
      errors.filter((e) => e.includes("LINE NOT ACCEPTED")), [],
      `a live exchange was blamed on its slot/world config: ${JSON.stringify(errors)}`,
    );
  } finally {
    console.error = origError;
    tie.stop();
    await new Promise<void>((resolve) => fakeHub.close(() => resolve()));
  }
});

test("tieline: stops (no reconnect) when the hub refuses the slot", { timeout: 10_000 }, async () => {
  // A refusal is an answer, not an outage. `reconnect: true` asks for redials
  // through outages; a 4409/4460/4461 close must override it, or the host
  // spends its backoff loop re-sending a REGISTER the hub just refused.
  // Subject: those refusals, so the board is open — on a default hub the
  // holder itself would be refused for reservation before it ever took WOPR.
  const hub = await startServer({ port: 0, trunk: { maxWorlds: 1, reservedWorlds: [] } });
  const local = { localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9" } as const;
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };

  const holder = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "HOLDER EXCH", region: "PORTLAND US", joshua: "period", slot: "WOPR",
    ...local, reconnect: false, onAssigned: () => {},
  });
  let assignedCalls = 0;
  const losers: Array<{ stop: () => void }> = [];
  const refusals = () => errors.filter((e) => e.includes("LINE REFUSED"));
  const dialRefused = async (world: number | undefined, expected: number) => {
    losers.push(startTieline({
      hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
      name: "LOSER EXCH", region: "PORTLAND US", joshua: "period", slot: "WOPR", world,
      ...local,
      reconnect: true,                                       // refusal must override
      onAssigned: () => { assignedCalls += 1; },
    }));
    const deadline = Date.now() + 3_000;
    while (refusals().length < expected && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(
      refusals().length, expected,
      `expected ${expected} LINE REFUSED logs (the refusal path also sets the no-redial flag), got: ${JSON.stringify(errors)}`,
    );
  };

  try {
    await new Promise((r) => setTimeout(r, 200));            // holder registered
    // No world asked for: the only world (maxWorlds: 1) already has WOPR, so
    // the hub is out of circuits entirely -> 4460.
    await dialRefused(undefined, 1);
    // World named explicitly: that world exists and has room, but its WOPR is
    // spoken for -> 4461. Retrying a taken slot would spin forever, so this
    // code has to be as terminal as 4460.
    await dialRefused(1, 2);
    assert.deepEqual(refusals().sort(), [
      "LINE REFUSED — NO CIRCUITS AVAILABLE",
      "LINE REFUSED — SLOT TAKEN",
    ]);
    assert.equal(assignedCalls, 0);
    const dir = await httpJson("GET", `http://127.0.0.1:${hub.port}/trunk/directory`);
    const worlds = JSON.parse(dir.body).worlds as Array<{ slots: unknown[] }>;
    assert.equal(worlds.flatMap((w) => w.slots).length, 1);
  } finally {
    console.error = origError;
    for (const l of losers) l.stop();
    holder.stop();
    await hub.close();
  }
});

test("tieline: stops (no reconnect) when the world is reserved", { timeout: 10_000 }, async () => {
  // World 1 is the flagship's on a default hub. A host that asks for it is
  // refused 4462 — an answer, not an outage, so like 4460/4461 it must be
  // terminal: redialling would re-send a REGISTER the hub will refuse every
  // time, and the operator would see nothing but silence.
  const hub = await startServer({ port: 0 });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  const refusals = () => errors.filter((e) => e.includes("LINE REFUSED"));

  const loser = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "PRETENDER EXCH", region: "PORTLAND US", joshua: "period",
    slot: "WOPR", world: 1,
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    reconnect: true,                                    // the refusal must override
    onAssigned: () => { assert.fail("a reserved world must not be assigned"); },
  });

  try {
    const deadline = Date.now() + 3_000;
    while (refusals().length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(refusals(), ["LINE REFUSED — WORLD RESERVED"]);
    // Past the first 5s backoff: a tieline that treated 4462 as an outage
    // would have redialled (and logged) again by now.
    await new Promise((r) => setTimeout(r, 6_000));
    assert.equal(refusals().length, 1, `redialled a refused world: ${JSON.stringify(errors)}`);
    const dir = await httpJson("GET", `http://127.0.0.1:${hub.port}/trunk/directory`);
    const worlds = JSON.parse(dir.body).worlds as Array<{ slots: unknown[] }>;
    assert.deepEqual(worlds.flatMap((w) => w.slots), []);   // nothing was placed
  } finally {
    console.error = origError;
    loser.stop();
    await hub.close();
  }
});

test("tieline: carries the reserve key, and lands in the reserved world with it", { timeout: 10_000 }, async () => {
  const hub = await startServer({ port: 0, trunk: { reserveKey: "FLAGSHIP-KEY" } });
  let resolvePlacement!: (p: { world: number; slot: string }) => void;
  const placement = new Promise<{ world: number; slot: string }>((resolve) => { resolvePlacement = resolve; });

  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "FLAGSHIP EXCH", region: "PORTLAND US", joshua: "period",
    slot: "WOPR", world: 1, key: "FLAGSHIP-KEY",
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    reconnect: false,
    onAssigned: (_exchange, world, slot) => resolvePlacement({ world, slot }),
  });

  try {
    assert.deepEqual(await placement, { world: 1, slot: "WOPR" });
  } finally {
    tie.stop();
    await hub.close();
  }
});

// ---- CLI pre-flight ---------------------------------------------------------
// `npm run tieline` checks TIELINE_SLOT against the roster before it dials, so
// a typo is one readable line instead of a malformed-frame close. The check
// derives its accepted list from ALL_SLOTS — this pins that HOME really has
// left it, on the surface an operator actually reads.

test("tieline CLI: HOME is refused before dialling, and is not offered as a choice",
     { timeout: 10_000 }, async () => {
  const cli = fileURLToPath(new URL("../src/tieline.ts", import.meta.url));
  const run = (slot: string) => new Promise<{ code: number | null; err: string }>((resolve) => {
    const p = spawn(process.execPath, [cli], {
      env: { ...process.env, TIELINE_SLOT: slot },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("close", (code) => resolve({ code, err }));
    // The bad-slot path exits before any socket is opened; if a regression lets
    // it through it would sit dialling the default hub forever, so bound it.
    setTimeout(() => p.kill("SIGKILL"), 8000).unref();
  });

  const home = await run("HOME");
  assert.equal(home.code, 1, `HOME must not be dialable: ${JSON.stringify(home)}`);
  // Match the one line, not all of stderr: node's own warnings share the
  // stream and could carry an unrelated "HOME" (a path, an env note).
  const offered = home.err.split("\n").find((l) => l.includes("TIELINE_SLOT MUST BE ONE OF"));
  assert.ok(offered, `no accepted-values line was printed: ${JSON.stringify(home.err)}`);
  assert.match(offered, /WOPR/);
  // The list an operator is shown must not name the seat they cannot have.
  assert.equal(/\bHOME\b/.test(offered), false, `HOME is still offered: ${offered}`);
});

// ---- place() and inbound origin (Task 5) -----------------------------------

test("tieline: place() resolves with the hub's PLACED, and rejects nothing", async () => {
  const hub = new WebSocketServer({ port: 0 });
  hub.on("connection", (ws) => {
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.t === "REGISTER") {
        ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 1, slot: "WOPR" }));
      } else if (f.t === "PLACE" && f.to.slot === "PANAM") {
        ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 5 }));
      } else if (f.t === "PLACE") {
        ws.send(JSON.stringify({ t: "REFUSED", call: f.call, reason: "offline" }));
      }
    });
  });
  await new Promise<void>((r) => hub.once("listening", () => r()));
  const port = (hub.address() as { port: number }).port;

  const seenOrigins: unknown[] = [];
  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "LIVE EXCH", region: "SEATTLE US",
    joshua: "period", localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    onOpen: (_chan: number, origin?: unknown) => { seenOrigins.push(origin); },
  });
  try {
    const ok = await tie.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof ok, "object");
    assert.equal((ok as { chan: number }).chan, 5);
    assert.equal(typeof (ok as { close: unknown }).close, "function");
    const no = await tie.place({ world: 1, slot: "PACTEL" });
    assert.equal(no, "offline");
  } finally {
    tie.stop();
    await new Promise<void>((r) => hub.close(() => r()));
  }
});

test("tieline: an inbound OPEN hands its origin to onOpen", async () => {
  const hub = new WebSocketServer({ port: 0 });
  hub.on("connection", (ws) => {
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).t !== "REGISTER") return;
      ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 1, slot: "WOPR" }));
      ws.send(JSON.stringify({ t: "OPEN", chan: 3, query: "",
                               origin: { world: 1, slot: "PANAM" } }));
    });
  });
  await new Promise<void>((r) => hub.once("listening", () => r()));
  const port = (hub.address() as { port: number }).port;

  const seen: unknown[] = [];
  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "LIVE EXCH", region: "SEATTLE US",
    joshua: "period", localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    onOpen: (_chan: number, origin?: unknown) => { seen.push(origin); },
  });
  try {
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(seen[0], { world: 1, slot: "PANAM" });
  } finally {
    tie.stop();
    await new Promise<void>((r) => hub.close(() => r()));
  }
});

// ---- inbound OPEN: the origin's shape decides the local attachment (Task 2) -

test("tieline: an OPEN from a machine opens a local leg, not a query dial", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", () => {});
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    hostSocket!.send(JSON.stringify({
      t: "OPEN", chan: 1, query: "", origin: { world: 1, slot: "PANAM" } }));
    await new Promise((r) => setTimeout(r, 200));
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "a machine call must mint its own session");
    assert.match(dialled.at(-1) ?? "", /surface=trunk-call/);
    assert.match(dialled.at(-1) ?? "", /session=/);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: an OPEN from a seat still pastes the hub's query", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", () => {});
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    hostSocket!.send(JSON.stringify({
      t: "OPEN", chan: 2, query: "surface=home-terminal&session=S9&token=T9",
      origin: { seat: "HDL1" } }));
    await new Promise((r) => setTimeout(r, 200));
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 0, "a visitor already has a session");
    assert.match(dialled.at(-1) ?? "", /session=S9/);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: a hub CLOSE that arrives while a machine call's mint is in flight does not leak the leg", async () => {
  // openMachineChannel mints a session (a real async POST) before it has
  // anything to register under `legs`. If the hub hangs up on that chan
  // during the mint, the CLOSE handler finds nothing yet — and the naive fix
  // is for the mint to just register the leg anyway once it resolves. That
  // resurrects a channel the hub has already forgotten: no second CLOSE is
  // ever coming, so the local session and socket leak for good. The delayed
  // stub bridge is what makes the mint slow enough to land the CLOSE inside
  // that window deterministically instead of by luck.
  const comms = await startStubComms();
  const bridge = await startStubBridge({ sessionDelayMs: 200 });
  const hub = new WebSocketServer({ port: 0 });
  let hostSocket: WebSocket | undefined;
  const fromTieline: Array<{ t: string; chan?: number }> = [];
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (data) => { fromTieline.push(JSON.parse(data.toString())); });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    hostSocket!.send(JSON.stringify({
      t: "OPEN", chan: 7, query: "", origin: { world: 1, slot: "PANAM" } }));
    // Well inside the 200ms mint delay: the session POST has not resolved yet.
    await new Promise((r) => setTimeout(r, 50));
    hostSocket!.send(JSON.stringify({ t: "CLOSE", chan: 7 }));
    // Past the mint delay: the leg has now resolved, found itself abandoned,
    // and must have closed rather than registering under chan 7.
    await new Promise((r) => setTimeout(r, 400));
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "the race requires the mint to actually complete");
    // Only the hub's own CLOSE must have produced an onClose — the abandoned
    // leg's own eventual self-close must not fire a second one, which is
    // what a leaked-but-later-noticed leg would do.
    assert.deepEqual(closed, [{ chan: 7, reason: undefined }]);
    // A live (leaked) leg would deliver this to the echoing stub comms and
    // relay the echo back as a FRAME the hub receives. An abandoned leg has
    // nothing registered under chan 7 to deliver to.
    hostSocket!.send(JSON.stringify({ t: "FRAME", chan: 7, data: "PING" }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      fromTieline.some((f) => f.t === "FRAME" && f.chan === 7),
      false,
      "an abandoned machine leg must not still be attached to its channel",
    );
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: a dropped hub connection cancels an in-flight machine mint before it can leak or misroute",
     { timeout: 20_000 }, async () => {
  // pendingLegs.clear() alone only removes the LOOKUP entry — it does not
  // touch the closure's captured `abandoned` variable. If retry() (a dropped
  // hub connection) does not also invoke every stored canceller, a mint that
  // is still in flight never learns it was abandoned: when it resolves it
  // falls through to the unconditional legs.set(), resurrecting an entry on
  // the very same `legs` map the reconnect will keep using. Worse, channel
  // numbering restarts after a reconnect, so that stale resolve can silently
  // overwrite — or in this test, be reachable as — a chan number a genuinely
  // new call reuses.
  const comms = await startStubComms();
  const bridge = await startStubBridge({ sessionDelayMs: 300 });
  const hub = new WebSocketServer({ port: 0 });
  const connections: WebSocket[] = [];
  const framesBySocket = new Map<WebSocket, Array<{ t: string; chan?: number }>>();
  hub.on("connection", (ws) => {
    connections.push(ws);
    const seen: Array<{ t: string; chan?: number }> = [];
    framesBySocket.set(ws, seen);
    ws.on("message", (data) => { seen.push(JSON.parse(data.toString())); });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: true,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
  });
  try {
    const untilConnected = async (n: number) => {
      const deadline = Date.now() + 9000;
      while (connections.length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      assert.ok(connections.length >= n, `expected ${n} connection(s), got ${connections.length}`);
    };

    await untilConnected(1);
    // Place a machine call whose mint (300ms) will still be outstanding when
    // this connection goes away.
    connections[0].send(JSON.stringify({
      t: "OPEN", chan: 9, query: "", origin: { world: 1, slot: "PANAM" } }));
    await new Promise((r) => setTimeout(r, 50));           // well inside the mint delay
    connections[0].terminate();                            // the hub connection drops mid-mint

    // Past both the mint delay and the fixed 5s reconnect backoff.
    await untilConnected(2);
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "the race requires the stale mint to actually complete");

    // The stale mint is long resolved by now. If it leaked into the shared
    // `legs` map (the bug this fixes), this FRAME — sent on the NEW
    // connection, for the SAME reused chan number — is relayed to the zombie
    // leg from the dropped call instead of being dropped as unrecognized,
    // and its echo comes back out over the CURRENT hub connection.
    connections[1].send(JSON.stringify({ t: "FRAME", chan: 9, data: "PING" }));
    await new Promise((r) => setTimeout(r, 300));
    const onSecond = framesBySocket.get(connections[1]) ?? [];
    assert.equal(
      onSecond.some((f) => f.t === "FRAME" && f.chan === 9),
      false,
      "a stale mint from a dropped connection must not resurrect or misroute chan 9 on the new one",
    );
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

// ---- a placed call gets an end of its own (Task 3) ------------------------

test("tieline: a placed call attaches a local leg and can be hung up", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  const fromHost: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      fromHost.push(f.t);
      if (f.t === "PLACE") ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 7 }));
    });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const placed = await t.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object");
    const call = placed as { chan: number; close: (r?: string) => void };
    assert.equal(call.chan, 7);
    await new Promise((r) => setTimeout(r, 200));
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "the placer needs a program of its own");
    assert.match(dialled.at(-1) ?? "", /surface=trunk-caller/);

    call.close("done");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fromHost.includes("CLOSE"), "close() must reach the hub");
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: the placer is told when the callee hangs up", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === "PLACE") ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 4 }));
    });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await t.place({ world: 1, slot: "PANAM" });
    await new Promise((r) => setTimeout(r, 150));
    hostSocket!.send(JSON.stringify({ t: "CLOSE", chan: 4, reason: "call ended" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(closed, [{ chan: 4, reason: "call ended" }]);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: a hub CLOSE that arrives while a placed call's attach is in flight does not leak the leg", async () => {
  // attachPlaced mints a session (a real async POST) before it has anything to
  // register under `legs`. If the hub hangs up on that chan during the mint,
  // the naive fix is to register the leg anyway once the mint resolves —
  // resurrecting a channel the hub has already forgotten, with no second
  // CLOSE ever coming to clean it up. The delayed stub bridge lands the CLOSE
  // inside that window deterministically instead of by luck.
  const comms = await startStubComms();
  const bridge = await startStubBridge({ sessionDelayMs: 200 });
  const hub = new WebSocketServer({ port: 0 });
  let hostSocket: WebSocket | undefined;
  const fromTieline: Array<{ t: string; chan?: number }> = [];
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      fromTieline.push(f);
      if (f.t === "PLACE") ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 7 }));
    });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const placedPromise = t.place({ world: 1, slot: "PANAM" });
    // Well inside the 200ms mint delay: the session POST has not resolved yet.
    await new Promise((r) => setTimeout(r, 50));
    hostSocket!.send(JSON.stringify({ t: "CLOSE", chan: 7 }));
    // place() itself still resolves once the (abandoned) attach settles.
    const placed = await placedPromise;
    assert.equal(typeof placed, "object");
    const mints = bridge.requests.filter((r) => r.path === "/api/session");
    assert.equal(mints.length, 1, "the race requires the mint to actually complete");
    // Only the hub's own CLOSE must have produced an onClose — the abandoned
    // leg's own eventual self-close must not fire a second one, which is what
    // a leaked-but-later-noticed leg would do.
    assert.deepEqual(closed, [{ chan: 7, reason: undefined }]);
    // A live (leaked) leg would deliver this to the echoing stub comms and
    // relay the echo back as a FRAME the hub receives. An abandoned leg has
    // nothing registered under chan 7 to deliver to. A real envelope (not
    // raw "PING") is required here: the caller side sets filterRitual, which
    // drops anything that does not decode as an "output"/"prompt" envelope —
    // a plain string would be silently filtered regardless of the guard,
    // making this assertion pass for the wrong reason.
    const envelope = encodeEnvelope({
      v: 1, session: "s", seq: 0, kind: "output", link: "trunk-caller", payload: "hi", eom: true,
    });
    hostSocket!.send(JSON.stringify({ t: "FRAME", chan: 7, data: envelope }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(
      fromTieline.some((f) => f.t === "FRAME" && f.chan === 7),
      false,
      "an abandoned placed-call leg must not still be attached to its channel",
    );
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});
