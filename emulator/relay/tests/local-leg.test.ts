// local-leg: the end of a machine call that is a program. It mints an ordinary
// bridge session and dials an ordinary /link, so a machine answering a machine
// runs the same code path that answers a person.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { openLocalLeg } from "../src/local-leg.ts";
import { decodeEnvelope, encodeEnvelope } from "../src/envelope.ts";

/** A bridge that mints one session, and a comms leg that records the URL it
 *  was dialled on and echoes envelopes the test pushes at it. */
async function stubs(opts: { mintStatus?: number } = {}): Promise<{
  bridgeUrl: string; commsUrl: string;
  dialled: string[]; sessionPosts: string[]; received: string[];
  push: (kind: string, payload: string) => void;
  close: () => Promise<void>;
}> {
  const sessionPosts: string[] = [];
  const bridge = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        sessionPosts.push(Buffer.concat(chunks).toString());
        const status = opts.mintStatus ?? 201;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 201 ? JSON.stringify({ session_id: "S1", token: "T1" }) : "{}");
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => bridge.listen(0, r));

  const dialled: string[] = [];
  const received: string[] = [];
  const sockets: import("ws").WebSocket[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => {
    dialled.push(req.url ?? "");
    sockets.push(ws);
    ws.on("message", (d) => received.push(d.toString()));
  });
  await new Promise<void>((r) => wss.once("listening", r));

  return {
    bridgeUrl: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`,
    commsUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    dialled, sessionPosts, received,
    push: (kind, payload) => {
      for (const s of sockets) {
        s.send(encodeEnvelope({ v: 1, session: "S1", seq: 0, kind: kind as never,
                                link: "trunk-call", payload, eom: true }));
      }
    },
    close: () => new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => bridge.close(() => r()));
    }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("local-leg: mints a session and dials /link with it", async () => {
  const s = await stubs();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.notEqual(leg, "refused");
    await settle();
    assert.equal(s.sessionPosts.length, 1);
    assert.match(s.sessionPosts[0], /"surface":"trunk-call"/);
    assert.equal(s.dialled.length, 1);
    assert.match(s.dialled[0], /surface=trunk-call/);
    assert.match(s.dialled[0], /session=S1/);
    assert.match(s.dialled[0], /token=T1/);
  } finally { await s.close(); }
});

test("local-leg: announces the origin as a control envelope before anything else", async () => {
  const s = await stubs();
  try {
    await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      origin: "world 1 slot PANAM", send: () => {}, close: () => {},
    });
    await settle();
    const first = decodeEnvelope(s.received[0]);
    assert.equal(first.kind, "control");
    assert.equal(first.payload, "ORIGIN world 1 slot PANAM");
  } finally { await s.close(); }
});

test("local-leg: buffers what arrives before the socket opens", async () => {
  const s = await stubs();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.notEqual(leg, "refused");
    (leg as { deliver: (d: string) => void }).deliver("EARLY");
    await settle();
    assert.ok(s.received.includes("EARLY"), "a frame delivered before open must not be lost");
  } finally { await s.close(); }
});

test("local-leg: the caller side drops the ritual, the callee side keeps it", async () => {
  const caller = await stubs();
  try {
    const out: string[] = [];
    await openLocalLeg({
      bridgeUrl: caller.bridgeUrl, commsUrl: caller.commsUrl, surface: "trunk-caller",
      filterRitual: true, send: (d) => out.push(d), close: () => {},
    });
    await settle();
    caller.push("handshake", "CARRIER DETECT");
    caller.push("control", "NO CARRIER");
    caller.push("output", "GREETINGS");
    await settle();
    const kinds = out.map((d) => decodeEnvelope(d).kind);
    assert.deepEqual(kinds, ["output"],
      "a calling program must not be handed the answering modem's ritual");
  } finally { await caller.close(); }
});

test("local-leg: a refused mint is a close with a reason, never a hang", async () => {
  const s = await stubs({ mintStatus: 400 });
  try {
    const closes: Array<string | undefined> = [];
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (reason) => closes.push(reason),
    });
    assert.equal(leg, "refused");
    assert.equal(closes.length, 1);
    assert.match(closes[0] ?? "", /session/i);
  } finally { await s.close(); }
});
