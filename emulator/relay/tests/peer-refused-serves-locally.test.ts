// A hosted exchange survives LINE REFUSED by design, not by accident (#86).
//
// Before #85 the tie line was its own process, and a terminal refusal from
// the hub took the whole hosted stack down with it. #85 moved the tie line
// inside the relay, which fixed that as a side effect — nothing pinned it.
// This file pins it: a peer whose slot the hub declines is told so through
// `onFatal`, stays up, and still answers a dial on its own `/link`. The
// process-exit policy lives in main.ts, not in anything imported here.
//
//   holder (real startTieline) ⇄ hub (real startServer, one world)
//   peer relay (real startServer, hosting a real tie line) ⇄ hub → 4461
//   local terminal ⇄ peer relay /link ⇄ stub bridge
//
// Deliberately NOT in server.test.ts / tieline.test.ts / peer-callback.test.ts:
// those files are being edited by other rounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startServer, LOOPBACK } from "./loopback.ts";
import { startTieline } from "../src/tieline.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { answerSessionLookup } from "./fake-bridge.ts";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

function fastConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.mode = "fast";
  return c;
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function captureConsole(stream: "error" | "log"): { lines: string[]; restore: () => void } {
  const original = console[stream];
  const lines: string[] = [];
  console[stream] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console[stream] = original; } };
}

/** The peer's bridge: answers the session lookup (#80) as `home-terminal`
 *  for every id and echoes each complete input back as output. */
function echoBridge(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const httpServer = http.createServer((req, res) => {
      if (answerSessionLookup(req, res, () => "home-terminal")) return;
      res.writeHead(500);
      res.end();
    });
    const wss = new WebSocketServer({ server: httpServer });
    wss.on("connection", (ws) => {
      const buffer: Envelope[] = [];
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        buffer.push(e);
        if (!e.eom) return;
        const [msg] = reassemble(buffer.splice(0));
        ws.send(encodeEnvelope({
          v: 1, session: e.session, seq: 0, kind: "output", link: e.link,
          payload: `ECHO: ${msg}`, eom: true,
        }));
      });
    });
    httpServer.listen(0, LOOPBACK, () => resolve({
      port: (httpServer.address() as { port: number }).port,
      close: () => { for (const c of wss.clients) c.terminate(); httpServer.close(); },
    }));
  });
}

/** Dial a relay's /link as a local terminal, say one thing once CONNECTED,
 *  and return the first output the line carries back. */
async function localDial(port: number): Promise<string> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/link?surface=home-terminal&session=86868686-8686-8686-8686-868686868686&token=tk`,
  );
  const pending: Record<string, Envelope[]> = {};
  try {
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("local dial got no answer")), 8_000);
      ws.on("message", (data) => {
        const e = decodeEnvelope(data.toString());
        (pending[e.kind] ??= []).push(e);
        if (!e.eom) return;
        const [msg] = reassemble(pending[e.kind]!.splice(0));
        if (e.kind === "handshake" && msg.startsWith("CONNECTED")) {
          ws.send(encodeEnvelope({
            v: 1, session: e.session, seq: 0, kind: "input", link: e.link,
            payload: "HELP GAMES", eom: true,
          }));
        }
        if (e.kind === "output") { clearTimeout(timeout); resolve(msg); }
      });
      ws.on("error", reject);
      ws.on("close", (code) => { clearTimeout(timeout); reject(new Error(`link closed ${code}`)); });
    });
  } finally {
    ws.close();
  }
}

test("a peer whose slot the hub refuses stays up and answers a local dial", { timeout: 20_000 }, async () => {
  // One world, board open: the holder takes WOPR, so the peer's REGISTER for
  // the same slot in the same world is refused 4461 SLOT TAKEN — terminal.
  const hub = await startServer({ port: 0, trunk: { maxWorlds: 1, reservedWorlds: [] } });
  const holder = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "HOLDER EXCH", region: "PORTLAND US", joshua: "period", slot: "WOPR",
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9", reconnect: false,
  });
  const bridge = await echoBridge();
  const errors = captureConsole("error");
  const fatal: string[] = [];
  let peer: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await waitFor(() => holder.assigned());
    peer = await startServer({
      port: 0, config: fastConfig(), bridgeUrl: `ws://127.0.0.1:${bridge.port}`,
      internalToken: "test-secret",
      tieline: {
        hubUrl: `ws://127.0.0.1:${hub.port}/trunk`, name: "BASEMENT EXCH",
        region: "PORTLAND US", joshua: "period", slot: "WOPR", world: 1,
        // reconnect left ON: a terminal refusal stops the redial by itself.
        reconnect: true,
      },
      onTielineFatal: (reason) => { fatal.push(reason); },
    });
    assert.ok(peer.tieline, "the relay under test must be a peer");

    // The refusal reaches the entrypoint's hook, once, with the hub's words.
    await waitFor(() => fatal.length > 0);
    assert.deepEqual(fatal, ["SLOT TAKEN"]);
    assert.ok(errors.lines.includes("LINE REFUSED — SLOT TAKEN"),
      `expected the operator line; got ${JSON.stringify(errors.lines)}`);
    assert.equal(peer.tieline.assigned(), false);
    assert.equal(peer.tieline.refused(), "SLOT TAKEN");

    // The exchange is still an exchange: a terminal on its own LAN dials in,
    // rides the ritual, and gets an answer from the local stack.
    assert.equal(await localDial(peer.port), "ECHO: HELP GAMES");

    // And it is still refused, not redialling: one LINE REFUSED, no ASSIGNED.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(errors.lines.filter((l) => l.includes("LINE REFUSED")).length, 1);
    assert.equal(fatal.length, 1);
    assert.equal(peer.tieline.assigned(), false);
  } finally {
    errors.restore();
    await peer?.close();
    bridge.close();
    holder.stop();
    await hub.close();
  }
});

test("a tie line told its REGISTER is unreadable reports that through onFatal too", { timeout: 10_000 }, async () => {
  // The other terminal path: LINE NOT ACCEPTED. Same hook, so an entrypoint
  // has one place to hold its policy for "the trunk is gone for good".
  const hub = await startServer({ port: 0, trunk: { maxWorlds: 1, reservedWorlds: [] } });
  const errors = captureConsole("error");
  const fatal: string[] = [];
  const line = startTieline({
    hubUrl: `ws://127.0.0.1:${hub.port}/trunk`,
    name: "TYPO EXCH", region: "NOWHERE", joshua: "period",
    slot: "NOT-A-SLOT", // off the roster: the hub cannot decode the REGISTER
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9", reconnect: true,
    onFatal: (reason) => { fatal.push(reason); },
  });
  try {
    await waitFor(() => fatal.length > 0);
    assert.equal(fatal.length, 1);
    assert.ok(errors.lines.some((l) => l.startsWith(`LINE NOT ACCEPTED — ${fatal[0]}`)),
      `expected the operator line to carry the same reason; got ${JSON.stringify(errors.lines)}`);
    assert.equal(line.assigned(), false);
  } finally {
    errors.restore();
    line.stop();
    await hub.close();
  }
});
