// End-to-end trunk test (trunk-federation spec, Task 4) — BOTH halves real:
//
//   visitor ⇄ hub (real startServer /x relay) ⇄ tieline (real startTieline)
//           ⇄ host comms (real startServer, fast mode) ⇄ stub bridge WS
//
// The only stub is the bridge (as in server.test.ts): an echo WS plus the
// /api/session HTTP endpoint the REST relay provisions sessions through.
//
// Federation-boundary proof: nothing between the visitor and the host bridge
// may parse or modify the envelopes. Fast mode ("off" profile: 0 baud,
// 0 latency, 0 jitter) makes a session fully deterministic, so the proof is a
// control experiment — the SAME session (same session id, token, input bytes)
// is run once through the trunk and once directly against the host comms, and
// both transcripts must match byte for byte in both directions:
//   - visitor side: every raw ws frame received (handshake + output),
//   - bridge side:  every raw ws frame the bridge received (shaped input).
// If the hub or tieline re-encoded, reordered, split, or annotated anything,
// the trunk transcript would diverge from the direct one.
//
// Note on DIAL: the brief says "send control DIAL", but /link auto-dials on
// connection (server.ts) — control DIAL is the RETRY signal after NO CARRIER
// (crt-kit link.ts). A redundant DIAL while connected would run
// connectUpstream() again and open a duplicate bridge socket, so like
// server.test.ts this test drives the auto-dial handshake to CONNECTED.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, LOOPBACK } from "./loopback.ts";
import { answerSessionLookup } from "./fake-bridge.ts";
import { startTieline } from "../src/tieline.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

const SESSION = "22222222-2222-2222-2222-222222222222";
const TOKEN = "tk-e2e";

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

/** Stub bridge, both faces on one port:
 *  - HTTP  POST /api/session  → 201 {session_id, token}  (reached via the
 *    hub's REST relay through the tieline — never called directly).
 *  - WS    /ws/session/<id>?token=…  → echoes every reassembled input back as
 *    one output envelope, recording the raw frames and auth material per
 *    connection so the test can compare trunk vs direct byte streams. */
async function startStubBridge(): Promise<{
  port: number;
  sessionPosts: string[];
  connections: Array<{ url: string; internalToken: string | undefined; received: string[] }>;
  close: () => Promise<void>;
}> {
  const sessionPosts: string[] = [];
  // Which surface this bridge minted the session with, for the lookup a
  // `/link` dial now makes before it paces anything (#80).
  let mintedSurface = "home-terminal";
  const connections: Array<{ url: string; internalToken: string | undefined; received: string[] }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        const body = Buffer.concat(chunks).toString();
        sessionPosts.push(body);
        mintedSurface = (JSON.parse(body || "{}") as { surface?: string }).surface ?? "";
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: SESSION, token: TOKEN }));
        return;
      }
      if (answerSessionLookup(req, res, (id) => id === SESSION ? mintedSurface : undefined)) return;
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
    const conn = {
      url: req.url ?? "",
      internalToken: req.headers["x-wopr-internal-token"] as string | undefined,
      received: [] as string[],
    };
    connections.push(conn);
    const buffer: Envelope[] = [];
    ws.on("message", (data) => {
      const text = data.toString();
      conn.received.push(text);
      const e = decodeEnvelope(text);
      buffer.push(e);
      if (e.eom) {
        const [msg] = reassemble(buffer.splice(0));
        ws.send(encodeEnvelope({
          v: 1, session: e.session, seq: 0, kind: "output",
          link: e.link, payload: `ECHO: ${msg}`, eom: true,
        }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, LOOPBACK, resolve));
  return {
    port: (server.address() as { port: number }).port,
    sessionPosts,
    connections,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => server.close(() => resolve()));
    }),
  };
}

interface Transcript { raw: string[]; handshakes: string[]; outputs: string[] }

/** One visitor session: connect, let the auto-dial reach CONNECTED, send the
 *  given input envelope bytes, resolve when the echoed output message lands.
 *  `raw` is every ws frame received, verbatim — the byte-identity evidence. */
function runVisitorSession(url: string, input: string): Promise<Transcript> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const raw: string[] = [];
    const handshakes: string[] = [];
    const outputs: string[] = [];
    const pending: Record<string, Envelope[]> = {};
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error(`session timed out; frames so far: ${JSON.stringify(raw)}`));
    }, 10_000);
    ws.on("message", (data) => {
      try {
        const text = data.toString();
        raw.push(text);
        const e = decodeEnvelope(text);
        (pending[e.kind] ??= []).push(e);
        if (!e.eom) return;
        const [msg] = reassemble(pending[e.kind].splice(0));
        if (e.kind === "handshake") {
          handshakes.push(msg);
          if (msg.startsWith("CONNECTED")) ws.send(input);
        }
        if (e.kind === "output") {
          outputs.push(msg);
          clearTimeout(timeout);
          ws.close();
          // Snapshot: nothing arriving during close teardown can mutate the result.
          resolve({ raw: [...raw], handshakes: [...handshakes], outputs: [...outputs] });
        }
      } catch (err) {
        clearTimeout(timeout);
        ws.terminate();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

test("trunk e2e: visitor -> hub -> tieline -> real comms -> bridge and back, byte-identical", async () => {
  const bridge = await startStubBridge();

  // The "host machine": a real comms layer in fast mode fronting the stub bridge.
  const config = structuredClone(DEFAULT_CONFIG);
  config.mode = "fast";
  const hostComms = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    internalToken: "test-secret",
    config,
  });

  // The hub. publicBase is explicit: with port 0 the default is computed
  // before listen and would read :0 (see switchboard-server.test.ts).
  // The board is opened (`reservedWorlds: []`) because the subject here is
  // byte-identity between a relayed call and a direct one — reservation would
  // only move the exchange to world 2 and add noise to every assertion below.
  // World 1 reservation is proved end-to-end in the two-tielines test.
  const hub = await startServer({
    port: 0, publicBase: "https://hub.example", trunk: { reservedWorlds: [] },
  });

  interface Placement { code: string; world: number; slot: string }
  let resolveAssigned!: (p: Placement) => void;
  const assigned = new Promise<Placement>((resolve) => { resolveAssigned = resolve; });
  const tieline = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "BASEMENT EXCH",
    region: "PORTLAND US",
    joshua: "period",
    localComms: `ws://127.0.0.1:${hostComms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    reconnect: false,
    onAssigned: (exchange, world, slot) => resolveAssigned({ code: exchange, world, slot }),
  });

  try {
    const { code, world, slot } = await assigned;
    const hubBase = `http://127.0.0.1:${hub.port}`;
    const hubWs = `ws://127.0.0.1:${hub.port}`;

    // ASSIGNED carries the placement the hub actually made: no world or slot
    // was requested, so it lands in the pinned world 1 on the first wildcard.
    assert.equal(world, 1);
    assert.equal(slot, "OTHER-1");

    // The exchange is listed under its world, with URLs pointing at the hub's
    // public base.
    const dir = JSON.parse((await httpJson("GET", `${hubBase}/trunk/directory`)).body);
    assert.equal(dir.worlds.length, 1);
    assert.equal(dir.worlds[0].n, 1);
    assert.equal(dir.worlds[0].slots.length, 1);
    assert.equal(dir.worlds[0].slots[0].name, "BASEMENT EXCH");
    assert.equal(dir.worlds[0].slots[0].slot, "OTHER-1");
    assert.equal(dir.worlds[0].slots[0].world, 1);
    assert.equal(dir.worlds[0].slots[0].link, `wss://hub.example/x/${code}/link`);

    // Session provisioning through the REST relay: hub -> tieline -> stub bridge HTTP.
    const post = await httpJson("POST", `${hubBase}/x/${code}/api/session`, JSON.stringify({ surface: "home-terminal" }));
    assert.equal(post.status, 201);
    const { session_id, token } = JSON.parse(post.body) as { session_id: string; token: string };
    assert.equal(session_id, SESSION);
    assert.equal(bridge.sessionPosts.length, 1, "the POST body must reach the host bridge exactly once");

    const query = `surface=home-terminal&session=${session_id}&token=${encodeURIComponent(token)}`;
    // Fixed input bytes, reused verbatim in both sessions.
    const input = encodeEnvelope({
      v: 1, session: session_id, seq: 0, kind: "input",
      link: "off", payload: "HELLO JOSHUA", eom: true,
    });

    // The relayed call, through the trunk.
    const viaTrunk = await runVisitorSession(`${hubWs}/x/${code}/link?${query}`, input);
    assert.deepEqual(viaTrunk.handshakes.map((h) => h.split(" ")[0]), ["CONNECTED"]);
    assert.deepEqual(viaTrunk.outputs, ["ECHO: HELLO JOSHUA"]);

    // The control: the identical session, directly against the host comms.
    const direct = await runVisitorSession(`ws://127.0.0.1:${hostComms.port}/link?${query}`, input);

    // Byte-identity, output direction: every raw frame the visitor received
    // through the trunk equals the direct transcript, byte for byte.
    assert.deepEqual(viaTrunk.raw, direct.raw);

    // Byte-identity, input direction: the bridge received the same raw frames
    // over both sessions — the trunk added, removed, and changed nothing.
    assert.equal(bridge.connections.length, 2);
    const [trunkConn, directConn] = bridge.connections;
    assert.deepEqual(trunkConn.received, directConn.received);

    // The relayed call reached the bridge as a first-class local session:
    // same session/token in the upstream URL, real internal auth header.
    assert.equal(trunkConn.url, `/ws/session/${session_id}?token=${encodeURIComponent(token)}`);
    assert.equal(trunkConn.internalToken, "test-secret");

    // Teardown semantics: a live relayed visitor is dropped when the tieline
    // stops, and the exchange leaves the directory.
    const lingering = new WebSocket(`${hubWs}/x/${code}/link?${query}`);
    await new Promise<void>((resolve, reject) => {
      lingering.once("message", () => resolve()); // CONNECTED — the channel is live
      lingering.once("error", reject);
    });
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      lingering.once("close", (c, r) => resolve({ code: c, reason: r.toString() }));
    });
    tieline.stop();
    const c = await closed;
    assert.equal(c.code, 1001);
    assert.equal(c.reason, "trunk dropped");
    // The board is empty again — but world 1 stays pinned, never absent.
    const dirAfter = JSON.parse((await httpJson("GET", `${hubBase}/trunk/directory`)).body);
    assert.deepEqual(dirAfter, { worlds: [{ n: 1, slots: [] }] });
  } finally {
    tieline.stop();
    await hub.close();
    await hostComms.close();
    await bridge.close();
  }
});

// Worlds, end to end: two independent machines dial the same switchboard and
// land in one shared world on different slots — the placement is the hub's
// answer (ASSIGNED), not something either host asserted for itself. Hanging up
// one tie line frees its slot for the next caller while the world stays live.
//
// The hub runs its real default board, so the shared world is world 2: world 1
// is reserved for the flagship, and neither of these hosts carries the key.
// That is the reservation proved through two real tielines — no host asked to
// avoid world 1, the switchboard simply never offered it.
//
// Neither tieline places a call here, so the host comms and stub bridge are
// only present because a tieline requires local endpoints to exist; nothing
// crosses them. The subject is the switchboard's occupancy board.
test("two tielines share world 2 in different slots (world 1 is reserved); hangup frees the slot", { timeout: 10_000 }, async () => {
  const bridge = await startStubBridge();
  const hostComms = await startServer({
    port: 0,
    bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
    config: DEFAULT_CONFIG,
    publicBase: "http://host.invalid",
  });
  // The hub relays only; its own bridgeUrl points at a closed port on purpose,
  // so a stray /link would fail loudly rather than borrow the host's bridge.
  const hub = await startServer({
    port: 0,
    bridgeUrl: "ws://127.0.0.1:9",
    config: DEFAULT_CONFIG,
    publicBase: "http://hub.invalid",
  });

  // Resolve on ASSIGNED — the hub's placement, reported back to the host.
  const mk = (slot: string) => new Promise<{ tie: { stop: () => void }; world: number; slot: string }>((resolve) => {
    const tie = startTieline({
      hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
      name: `${slot} EXCH`,
      region: "PORTLAND US",
      joshua: "period",
      slot,
      localComms: `ws://127.0.0.1:${hostComms.port}`,
      localBridge: `http://127.0.0.1:${bridge.port}`,
      reconnect: false,
      onAssigned: (_exchange, world, assignedSlot) => resolve({ tie, world, slot: assignedSlot }),
    });
  });

  // World 1 is listed, flagged reserved, and stays empty throughout: the two
  // hosts live in world 2.
  const dirSlots = async (): Promise<string[]> => {
    const dir = JSON.parse((await httpJson("GET", `http://127.0.0.1:${hub.port}/trunk/directory`)).body);
    assert.deepEqual(dir.worlds.map((w: { n: number }) => w.n), [1, 2]);
    assert.deepEqual(dir.worlds[0], { n: 1, reserved: true, slots: [] });
    return dir.worlds[1].slots.map((s: { slot: string }) => s.slot);
  };

  // Sequential, not parallel: the second REGISTER must see the first already
  // placed, which is the whole point — otherwise the shared world is a race.
  const wopr = await mk("WOPR");
  const school = await mk("SCHOOL");
  try {
    assert.equal(wopr.world, 2, "an unkeyed host must never be placed in the reserved world");
    assert.equal(wopr.slot, "WOPR");
    assert.equal(school.world, 2);
    assert.equal(school.slot, "SCHOOL");

    // One world, two slots, in roster order.
    assert.deepEqual(await dirSlots(), ["WOPR", "SCHOOL"]);

    // Hanging up frees the slot; the world survives its departure.
    school.tie.stop();
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(await dirSlots(), ["WOPR"]);
  } finally {
    wopr.tie.stop();
    school.tie.stop();
    await hub.close();
    await hostComms.close();
    await bridge.close();
  }
});

// One machine-originated call, end to end, over real sockets: two real host
// exchanges register with a real hub, one calls the other's slot, and the
// callee learns who called. onOpen's inbound-only asymmetry (spec §1) is
// asserted directly: the placing side must never see its own placed call
// echoed back as an inbound open.
//
// Deliberately narrow: both tielines point at dead local endpoints, so this
// pins the SIGNALLING alone — who is told about the call, and what they are
// told. Words crossing the call and the drop that ends it are the test below.
test("e2e: one exchange places a call to another's slot, and the callee is told who called", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hubUrl = `ws://127.0.0.1:${server.port}/trunk`;
  const inboundA: Array<{ chan: number; origin?: unknown }> = [];
  const inboundB: Array<{ chan: number; origin?: unknown }> = [];

  const a = startTieline({ hubUrl, name: "A EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "WOPR", localComms: "ws://127.0.0.1:9",
    localBridge: "http://127.0.0.1:9",
    onOpen: (chan: number, origin?: unknown) => { inboundA.push({ chan, origin }); } });
  const b = startTieline({ hubUrl, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM", localComms: "ws://127.0.0.1:9",
    localBridge: "http://127.0.0.1:9",
    onOpen: (chan: number, origin?: unknown) => { inboundB.push({ chan, origin }); } });

  try {
    // Both must be ASSIGNED before either can place.
    const deadline = Date.now() + 5000;
    while ((!a.assigned() || !b.assigned()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(a.assigned() && b.assigned(), "both tielines must register first");

    const placed = await a.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object", `A could not call B: ${JSON.stringify(placed)}`);

    while (inboundB.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(inboundB.length, 1, "B never saw the inbound call");
    assert.deepEqual(inboundB[0].origin, { world: 1, slot: "WOPR" },
      "B must be told which slot called it");
    assert.equal(inboundA.length, 0, "A placed the call; it must not also receive one");
  } finally {
    a.stop(); b.stop(); await server.close();
  }
});

test("e2e: a machine calls a machine, words cross both ways, and the line drops clean",
  { timeout: 15_000 }, async () => {
  const hubServer = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hubUrl = `ws://127.0.0.1:${hubServer.port}/trunk`;

  // Each exchange is a full stack: its own bridge and its own comms relay.
  const bridgeA = await startStubBridge();
  const bridgeB = await startStubBridge();
  // startServer's bridgeUrl is a ws:// url; the tieline's localBridge is http://.
  // Authentic profiles throughout — the callee answers on `trunk-call`
  // (dialup-1200), so this exercises the shaping and framing production runs,
  // not `fast`. Only the dial ritual's CLOCK is scaled: at timeScale 1 it is
  // 6-9s of sleeps whose RINGING leg is an unseeded Math.random, which would
  // make the test both slow and nondeterministic. Seeded and scaled, every
  // transition still runs, in order.
  const hs = { timeScale: 0.01, rng: () => 0.5, failRate: 0 };
  const commsA = await startServer({ port: 0, bridgeUrl: `ws://127.0.0.1:${bridgeA.port}`, handshake: hs });
  const commsB = await startServer({ port: 0, bridgeUrl: `ws://127.0.0.1:${bridgeB.port}`, handshake: hs });

  const closesA: Array<{ chan: number; reason?: string }> = [];
  const a = startTieline({ hubUrl, name: "A EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "WOPR",
    localComms: `ws://127.0.0.1:${commsA.port}`, localBridge: `http://127.0.0.1:${bridgeA.port}`,
    onClose: (chan, reason) => closesA.push({ chan, reason }) });
  const b = startTieline({ hubUrl, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM",
    localComms: `ws://127.0.0.1:${commsB.port}`, localBridge: `http://127.0.0.1:${bridgeB.port}` });

  try {
    const deadline = Date.now() + 8000;
    while ((!a.assigned() || !b.assigned()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(a.assigned() && b.assigned());

    const placed = await a.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object", `A could not call B: ${JSON.stringify(placed)}`);
    const call = placed as { chan: number; close: (r?: string) => void };

    // Both ends minted a session of their own: the placer's program and the
    // answerer's program are what talk.
    while ((bridgeA.sessionPosts.length === 0 || bridgeB.sessionPosts.length === 0)
           && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(bridgeA.sessionPosts.length, 1, "the placer needs an end of its own");
    assert.equal(bridgeB.sessionPosts.length, 1, "the callee needs an end of its own");
    assert.match(bridgeA.sessionPosts[0], /"surface":"trunk-caller"/);
    assert.match(bridgeB.sessionPosts[0], /"surface":"trunk-call"/);

    // B's program was told who called, on the uniform rule.
    while (bridgeB.connections.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    while (bridgeB.connections[0].received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // A message, not a frame: at 1200 baud the ORIGIN control envelope is
    // paced out in 8-byte quanta like everything else on that link, and the
    // bridge reassembles on `eom` (emulator/node app/main.py accumulates per
    // kind, control included). Assert what B's program is told.
    const firstMessage = (): string | undefined => {
      const frames = bridgeB.connections[0].received.map(decodeEnvelope);
      const end = frames.findIndex((e) => e.eom);
      return end < 0 ? undefined : reassemble(frames.slice(0, end + 1))[0];
    };
    while (firstMessage() === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(firstMessage(), "ORIGIN world 1 slot WOPR");

    // Words cross: the stub bridge echoes, so A's program hears B's program.
    while (bridgeA.connections.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const heardByA = () => bridgeA.connections[0].received
      .map((r) => decodeEnvelope(r).payload).join("");
    while (!heardByA().includes("ECHO") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(heardByA(), /ECHO/, "B's answer must reach A's program");

    // ...and only the answer. B answers on `trunk-call` (dialup-1200), so its
    // /link runs the full dial FSM and every DIALING/RINGING/CARRIER DETECT
    // frame travels back over the trunk — correct for a visitor, who is
    // watching a modem connect, and wrong for a calling PROGRAM, which never
    // had to answer its own modem. The caller's leg filters them on the way
    // in; by now the ECHO has landed, so the whole ritual has had its chance
    // to arrive ahead of it.
    assert.deepEqual(
      [...new Set(bridgeA.connections[0].received.map((r) => decodeEnvelope(r).kind))],
      ["output"],
      "a calling program must be handed the far end's output and nothing else",
    );
    assert.doesNotMatch(heardByA(), /DIALING|RINGING|CARRIER|HANDSHAKE|CONNECT/,
      "the answering end's dial ritual must not reach the calling program");

    // And a clean close, seen at both ends.
    call.close("done");
    while (closesA.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(closesA.length, 1);
  } finally {
    a.stop(); b.stop();
    await commsA.close(); await commsB.close();
    await bridgeA.close(); await bridgeB.close();
    await hubServer.close();
  }
});
