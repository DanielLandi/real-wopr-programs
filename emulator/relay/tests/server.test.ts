// End-to-end proxy test: fake surface ⇄ comms server ⇄ fake bridge.
// Also the toggle test (§7): flipping COMMS_MODE requires no change in bridge
// or surface code — the same client/bridge code runs under both modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { DEFAULT_CONFIG, type CommsConfig } from "../src/config.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

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
