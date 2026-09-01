// local-leg: the end of a machine call that is a program. It mints an ordinary
// bridge session and dials an ordinary /link, so a machine answering a machine
// runs the same code path that answers a person.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { openLocalLeg } from "../src/local-leg.ts";
import { decodeEnvelope, encodeEnvelope } from "../src/envelope.ts";
import { Inbox, orClosed } from "./inbox.ts";
import { LOOPBACK } from "./loopback.ts";

/** A bridge that mints one session, and a comms leg that records the URL it
 *  was dialled on and echoes envelopes the test pushes at it.
 *
 *  `dialled` and `received` are inboxes, listening from before the leg under
 *  test exists: a test waits on the dial, or on the N-th frame, instead of
 *  sleeping and hoping the loopback round trip fit inside the nap. Under a
 *  loaded parallel run it did not (#114): the upgrade landed after the
 *  60 ms nap, and the assertions read an empty list. */
async function stubs(opts: { mintStatus?: number } = {}): Promise<{
  bridgeUrl: string; commsUrl: string;
  dialled: Inbox<string>; sessionPosts: string[]; sessionHeaders: http.IncomingHttpHeaders[];
  received: Inbox<string>;
  push: (kind: string, payload: string) => void;
  close: () => Promise<void>;
}> {
  const sessionPosts: string[] = [];
  const sessionHeaders: http.IncomingHttpHeaders[] = [];
  const bridge = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        sessionPosts.push(Buffer.concat(chunks).toString());
        sessionHeaders.push(req.headers);
        const status = opts.mintStatus ?? 201;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 201 ? JSON.stringify({ session_id: "S1", token: "T1" }) : "{}");
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  // Both stubs bind LOOPBACK, the family the leg's own dial uses — see
  // loopback.ts for why a listener that skips it can be handed a port
  // another process already holds on 127.0.0.1. This file was the first to
  // get it right (#114); it goes through the shared constant now (#153).
  await new Promise<void>((r) => bridge.listen(0, LOOPBACK, r));

  const dialled = new Inbox<string>();
  const received = new Inbox<string>();
  const sockets: import("ws").WebSocket[] = [];
  const wss = new WebSocketServer({ port: 0, host: LOOPBACK });
  wss.on("connection", (ws, req) => {
    sockets.push(ws);
    ws.on("message", (d) => received.push(d.toString()));
    dialled.push(req.url ?? "");
  });
  await new Promise<void>((r) => wss.once("listening", r));

  return {
    bridgeUrl: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`,
    commsUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    dialled, sessionPosts, sessionHeaders, received,
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

test("local-leg: mints a session and dials /link with it", async () => {
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (r) => closes.push(r),
    });
    assert.notEqual(leg, "refused");
    assert.equal(s.sessionPosts.length, 1);
    assert.match(s.sessionPosts[0], /"surface":"trunk-call"/);
    const url = await orClosed(s.dialled.nth(0), closes);
    assert.equal(s.dialled.all.length, 1);
    assert.match(url, /surface=trunk-call/);
    assert.match(url, /session=S1/);
    assert.match(url, /token=T1/);
  } finally { await s.close(); }
});

test("local-leg: announces the origin as a control envelope before anything else", async () => {
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      origin: "world 1 slot PANAM", send: () => {}, close: (r) => closes.push(r),
    });
    const first = decodeEnvelope(await orClosed(s.received.nth(0), closes));
    assert.equal(first.kind, "control");
    assert.equal(first.payload, "ORIGIN world 1 slot PANAM");
  } finally { await s.close(); }
});

test("local-leg: buffers what arrives before the socket opens", async () => {
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (r) => closes.push(r),
    });
    assert.notEqual(leg, "refused");
    (leg as { deliver: (d: string) => void }).deliver("EARLY");
    assert.equal(await orClosed(s.received.nth(0), closes), "EARLY",
                 "a frame delivered before open must not be lost");
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
  const callerCloses = new Inbox<string | undefined>();
  const calleeCloses = new Inbox<string | undefined>();
  try {
    const callerLeg = await openLocalLeg({
      bridgeUrl: caller.bridgeUrl, commsUrl: caller.commsUrl, surface: "trunk-caller",
      filterRitual: true, send: () => {}, close: (r) => callerCloses.push(r),
    });
    const calleeLeg = await openLocalLeg({
      bridgeUrl: callee.bridgeUrl, commsUrl: callee.commsUrl, surface: "trunk-call",
      send: () => {}, close: (r) => calleeCloses.push(r),
    });
    assert.notEqual(callerLeg, "refused");
    assert.notEqual(calleeLeg, "refused");

    for (const leg of [callerLeg, calleeLeg]) {
      const d = (leg as { deliver: (data: string) => void }).deliver;
      d(env("handshake", "CARRIER DETECT"));
      d(env("control", "NO CARRIER"));
      d(env("output", "GREETINGS"));
    }
    // GREETINGS is the last frame either leg was handed, so once it has
    // arrived the list is complete: the socket delivers in order, and
    // nothing was sent after it.
    await orClosed(caller.received.nth(0), callerCloses);
    await orClosed(callee.received.nth(2), calleeCloses);

    // The calling program is handed the answer, and nothing of the modem.
    assert.deepEqual(kindsOf(caller.received.all), ["output"],
      "a calling program must not be handed the answering modem's ritual");
    assert.deepEqual(caller.received.all.map((d) => decodeEnvelope(d).payload), ["GREETINGS"]);
    // The answering side is not filtered: its own surface runs the ritual, and
    // a visitor relayed onto it must still see every frame of it.
    assert.deepEqual(kindsOf(callee.received.all), ["handshake", "control", "output"],
      "the callee side must keep everything");
  } finally { await caller.close(); await callee.close(); }
});

// Every kind, named individually, because #71 records that two of the five
// were never covered at all — and `input`, the one the whole two-way call
// depends on, was among them and was being dropped. A test that only ever
// asserted "the ritual is filtered" cannot tell a correct filter from one that
// eats the conversation as well.
test("local-leg: filterRitual keeps conversation and drops only the modem", async () => {
  const env = (kind: string, payload: string) => encodeEnvelope({
    v: 1, session: "S1", seq: 0, kind: kind as never,
    link: "trunk-caller", payload, eom: true,
  });
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-caller",
      filterRitual: true, send: () => {}, close: (r) => closes.push(r),
    });
    assert.notEqual(leg, "refused");
    const d = (leg as { deliver: (data: string) => void }).deliver;
    // The ORIGIN control envelope this leg sends itself is not in play: no
    // `origin` was passed, so everything on the comms socket arrived via
    // `deliver`.
    d(env("output", "GREETINGS PROFESSOR FALKEN."));
    d(env("prompt", ">"));
    d(env("input", "HELLO"));
    d(env("handshake", "CARRIER DETECT"));
    d(env("control", "NO CARRIER"));
    // HELLO is the last frame that may cross; the two after it are dropped
    // synchronously in `deliver`, so nothing can arrive behind it.
    await orClosed(s.received.nth(2), closes);

    const got = s.received.all.map((r) => {
      const e = decodeEnvelope(r);
      return [e.kind, e.payload];
    });
    assert.deepEqual(got, [
      ["output", "GREETINGS PROFESSOR FALKEN."],
      ["prompt", ">"],
      // The load-bearing row: a person answered the ring and typed. Without
      // it the callback is a monologue.
      ["input", "HELLO"],
    ], "handshake and control are the modem; output, prompt and input are the call");
  } finally { await s.close(); }
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

test("local-leg: frames held before the dial completes are bounded, not unbounded", async () => {
  // The dial is same-host and quick, so nothing legitimate comes near the cap
  // — but "bounded in practice" is not bounded, and this is the same
  // mutual-untrust boundary the hub's held-ring frames are capped at.
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (r) => closes.push(r),
    });
    if (leg === "refused") throw new Error("the mint should have succeeded");
    // Synchronously, before the WebSocket has finished connecting: every one
    // of these is held rather than sent.
    const big = "x".repeat(8192);
    for (let i = 0; i < 5; i++) leg.deliver(big);
    assert.equal(closes.all[0], "greeting exceeds hold capacity",
                 "past the cap the call is hung up, not grown");
    // The leg hangs its own socket up on the way out; the second close is the
    // socket's, and after it nothing can be sent. The list is complete.
    assert.equal(await closes.nth(1), "local leg closed");
    assert.deepEqual(s.received.all, [], "and nothing held past the cap is ever delivered");
  } finally {
    await s.close();
  }
});

test("local-leg: frames under the cap are still held and flushed on connect", async () => {
  const s = await stubs();
  const closes = new Inbox<string | undefined>();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (r) => closes.push(r),
    });
    if (leg === "refused") throw new Error("the mint should have succeeded");
    leg.deliver("x".repeat(8192));
    await orClosed(s.received.nth(0), closes);
    assert.equal(s.received.all.length, 1, "the cap must not cost the ordinary case its buffer");
  } finally {
    await s.close();
  }
});

// ---- #74: the mint is authenticated -------------------------------------
//
// The two trunk surfaces are pre-authenticated (a `trunk-caller` session is
// behind the front door on connect) and unpaced (profile `off`), so the
// bridge now requires the service-to-service token to mint one. This leg is
// the only caller of those surfaces, and it runs inside a process that
// already holds the token.

test("local-leg: sends the internal token on the mint", async () => {
  const s = await stubs();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      internalToken: "SECRET", send: () => {}, close: () => {},
    });
    assert.notEqual(leg, "refused");
    assert.equal(s.sessionHeaders.length, 1);
    assert.equal(s.sessionHeaders[0]["x-wopr-internal-token"], "SECRET");
  } finally { await s.close(); }
});

test("local-leg: omits the header entirely when it has no token", async () => {
  // Not a blank header: an unconfigured relay must read as "no header" and
  // not as "wrong token" in a bridge's logs.
  const saved = process.env.BRIDGE_INTERNAL_TOKEN;
  delete process.env.BRIDGE_INTERNAL_TOKEN;
  const s = await stubs();
  try {
    await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.equal(s.sessionHeaders.length, 1);
    assert.equal("x-wopr-internal-token" in s.sessionHeaders[0], false);
  } finally {
    await s.close();
    if (saved !== undefined) process.env.BRIDGE_INTERNAL_TOKEN = saved;
  }
});

test("local-leg: falls back to BRIDGE_INTERNAL_TOKEN when given no option", async () => {
  // The tieline runs as its own process beside a local stack; server.ts
  // resolves `opts.internalToken ?? process.env… ?? ""` and this mirrors it,
  // so a host that exports the variable needs no extra wiring.
  const saved = process.env.BRIDGE_INTERNAL_TOKEN;
  process.env.BRIDGE_INTERNAL_TOKEN = "FROM-ENV";
  const s = await stubs();
  try {
    await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-caller",
      send: () => {}, close: () => {},
    });
    assert.equal(s.sessionHeaders[0]["x-wopr-internal-token"], "FROM-ENV");
  } finally {
    await s.close();
    if (saved === undefined) delete process.env.BRIDGE_INTERNAL_TOKEN;
    else process.env.BRIDGE_INTERNAL_TOKEN = saved;
  }
});

test("local-leg: a bridge that refuses the mint with 401 is a refusal, not a crash", async () => {
  const s = await stubs({ mintStatus: 401 });
  const closes: Array<string | undefined> = [];
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      internalToken: "WRONG", send: () => {}, close: (r) => closes.push(r),
    });
    assert.equal(leg, "refused");
    assert.deepEqual(closes, ["no session"]);
  } finally { await s.close(); }
});
