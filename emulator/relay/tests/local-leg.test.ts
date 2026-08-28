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

test("local-leg: the caller side drops the far end's ritual, the callee side keeps it", async () => {
  // INBOUND is the direction under test. `deliver` is what the trunk pushes
  // into, and the far end's dial ritual is what arrives on it — the callee's
  // /link runs the FSM and its DIALING/RINGING/CARRIER DETECT frames travel
  // back over the trunk to the caller.
  //
  // Driving the stub comms socket instead would exercise the OUTBOUND path,
  // which on a `trunk-caller` surface (profile `off`, handshake "none") never
  // carries a ritual frame at all — so it passed whether or not the guard
  // existed, which is how the filter came to sit on the wrong side for nine
  // reviews. Assert against what reaches the program: the comms socket.
  const env = (kind: string, payload: string) => encodeEnvelope({
    v: 1, session: "S1", seq: 0, kind: kind as never,
    link: "trunk-caller", payload, eom: true,
  });
  const kindsOf = (frames: string[]) => frames.map((d) => decodeEnvelope(d).kind);

  const caller = await stubs();
  const callee = await stubs();
  try {
    const callerLeg = await openLocalLeg({
      bridgeUrl: caller.bridgeUrl, commsUrl: caller.commsUrl, surface: "trunk-caller",
      filterRitual: true, send: () => {}, close: () => {},
    });
    const calleeLeg = await openLocalLeg({
      bridgeUrl: callee.bridgeUrl, commsUrl: callee.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.notEqual(callerLeg, "refused");
    assert.notEqual(calleeLeg, "refused");
    await settle();

    for (const leg of [callerLeg, calleeLeg]) {
      const d = (leg as { deliver: (data: string) => void }).deliver;
      d(env("handshake", "CARRIER DETECT"));
      d(env("control", "NO CARRIER"));
      d(env("output", "GREETINGS"));
    }
    await settle();

    // The calling program is handed the answer, and nothing of the modem.
    assert.deepEqual(kindsOf(caller.received), ["output"],
      "a calling program must not be handed the answering modem's ritual");
    assert.deepEqual(caller.received.map((d) => decodeEnvelope(d).payload), ["GREETINGS"]);
    // The answering side is not filtered: its own surface runs the ritual, and
    // a visitor relayed onto it must still see every frame of it.
    assert.deepEqual(kindsOf(callee.received), ["handshake", "control", "output"],
      "the callee side must keep everything");
  } finally { await caller.close(); await callee.close(); }
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
