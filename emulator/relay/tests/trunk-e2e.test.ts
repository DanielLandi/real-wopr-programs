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
import { startServer } from "../src/server.ts";
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
  const connections: Array<{ url: string; internalToken: string | undefined; received: string[] }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        sessionPosts.push(Buffer.concat(chunks).toString());
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ session_id: SESSION, token: TOKEN }));
        return;
      }
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

  await new Promise<void>((resolve) => server.listen(0, resolve));
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
  const hub = await startServer({ port: 0, publicBase: "https://hub.example" });

  let resolveAssigned!: (exchange: string) => void;
  const assigned = new Promise<string>((resolve) => { resolveAssigned = resolve; });
  const tieline = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "BASEMENT EXCH",
    region: "PORTLAND US",
    joshua: "period",
    localComms: `ws://127.0.0.1:${hostComms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    reconnect: false,
    onAssigned: resolveAssigned,
  });

  try {
    const code = await assigned;
    const hubBase = `http://127.0.0.1:${hub.port}`;
    const hubWs = `ws://127.0.0.1:${hub.port}`;

    // The exchange is listed, with URLs pointing at the hub's public base.
    const dir = JSON.parse((await httpJson("GET", `${hubBase}/trunk/directory`)).body);
    assert.equal(dir.exchanges.length, 1);
    assert.equal(dir.exchanges[0].name, "BASEMENT EXCH");
    assert.equal(dir.exchanges[0].link, `wss://hub.example/x/${code}/link`);

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
    const dirAfter = JSON.parse((await httpJson("GET", `${hubBase}/trunk/directory`)).body);
    assert.deepEqual(dirAfter.exchanges, []);
  } finally {
    tieline.stop();
    await hub.close();
    await hostComms.close();
    await bridge.close();
  }
});
