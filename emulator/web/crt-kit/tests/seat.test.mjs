// A seat is the thing a machine can ring. It is NOT a call: it outlives every
// call the terminal makes, which is the whole reason a callback can arrive
// after the visitor hangs up (spec §2).

import test from "node:test";
import assert from "node:assert/strict";
import { WoprLink } from "../src/link.ts";
import { WoprSeat } from "../src/seat.ts";

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** Stand a fake WebSocket constructor in the global slot connect() reaches
 *  for, and hand back the instances it makes. Restored via t.after. */
function withFakeSocket(t) {
  const made = [];
  class FakeWebSocket {
    static CONNECTING = CONNECTING;
    static OPEN = OPEN;
    static CLOSING = CLOSING;
    static CLOSED = CLOSED;
    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.sent = [];
      made.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.readyState = CLOSED;
    }
    /** What the browser does when the far end goes away. */
    dropCarrier() {
      this.readyState = CLOSED;
      this.onclose?.();
    }
    accept() {
      this.readyState = OPEN;
      this.onopen?.();
    }
  }
  const prior = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = prior;
  });
  return made;
}

// The hub's own name for the leg, which it stamps into the `session` field of
// every envelope it sends down a /seat socket (relay/src/seats.ts's private
// `envelope()`, which sends `session: id`). Distinct from the token on purpose:
// these two must never be confused, and a test fixture that used the same
// string for both could not tell them apart.
const LEG_ID = "LEG7";

const control = (payload) => JSON.stringify({
  v: 1, session: LEG_ID, seq: 0, kind: "control", link: "seat", payload, eom: true,
});

test("a seat asks for its token — the hub never volunteers one", (t) => {
  const made = withFakeSocket(t);
  new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" }).connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  const sent = ws.sent.map((s) => JSON.parse(s).payload);
  assert.deepEqual(sent, ["SEAT?"],
    "send-on-connect is unimplementable hub-side; the client must ask");
});

test("the surface rides on the URL", (t) => {
  const made = withFakeSocket(t);
  new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" }).connect();
  assert.match(made[0].url, /surface=home-terminal/);
});

test("the token is kept, and a ring is announced", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  assert.equal(seat.token, "TOK1");
  ws.onmessage?.({ data: control("RING CHEYENNE MOUNTAIN") });
  assert.deepEqual(events, [
    { type: "seated", token: "TOK1" },
    { type: "ring", from: "CHEYENNE MOUNTAIN" },
  ]);
});

test("answering and declining each send one control frame", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.sent.length = 0;
  seat.answer();
  seat.reject();
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).payload), ["ANSWER", "REJECT"]);
});

test("send() puts one input envelope on the wire once seated, nothing before", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();

  // Before the handshake has produced a token, send() is a no-op — same as
  // answer()/reject() before a token exists. The connect-time SEAT? is
  // already sitting in ws.sent; clear it so this checks send() alone.
  ws.sent.length = 0;
  seat.send("HELLO");
  assert.deepEqual(ws.sent, [], "send() before a token must not touch the wire");

  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.sent.length = 0;
  seat.send("HELLO");
  assert.equal(ws.sent.length, 1, "send() after seating must put exactly one envelope on the wire");
  const env = JSON.parse(ws.sent[0]);
  // seq is monotonic across every envelope this seat has sent, not reset per
  // call — the earlier SEAT? (sent on open, before this test cleared
  // ws.sent) already consumed seq 0, so the first send() lands on seq 1.
  // `session` carries the LEG ID the hub disclosed on the SEAT reply, never
  // the token — see the token-containment test below for why.
  assert.deepEqual(env, {
    v: 1, session: LEG_ID, seq: 1, kind: "input", link: "seat", payload: "HELLO", eom: true,
  });
});

// The one credential the handle design exists to keep away from machines. An
// envelope a seat sends does not stop at the hub: once a ring is answered it is
// forwarded byte for byte into the machine on the other end (server.ts's
// seatWss -> seats.inboundOf -> Switchboard.clientFrame -> a FRAME on the
// trunk), and that machine may be a foreign exchange. So the assertion is on
// the RAW text of every envelope this client puts on the wire, across the whole
// handshake-answer-converse sequence, not on one field of one frame.
test("the seat token never appears in anything the seat sends", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  seat.answer();
  seat.send("HELLO");
  seat.reject();
  assert.ok(ws.sent.length >= 4, "the sequence under test must have reached the wire");
  assert.equal(seat.token, "TOK1", "the terminal still knows its own token");
  for (const raw of ws.sent) {
    assert.ok(!raw.includes("TOK1"),
      `the visitor's seat token escaped in an envelope: ${raw}`);
  }
});

test("the leg id from the SEAT reply is what rides in `session`", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  // Before the reply there is no leg id, and an empty session is what
  // decodeEnvelope accepts and the hub ignores — it routes a /seat socket by
  // the socket, never by this field.
  assert.equal(JSON.parse(ws.sent[0]).session, "");
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.sent.length = 0;
  seat.send("HELLO");
  assert.equal(JSON.parse(ws.sent[0]).session, LEG_ID);
});

test("after answering, ordinary frames are delivered as frames", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.onmessage?.({ data: JSON.stringify({
    v: 1, session: "x", seq: 1, kind: "output",
    payload: "GREETINGS PROFESSOR FALKEN.", eom: true }) });
  assert.equal(events.at(-1).type, "frame");
  assert.equal(events.at(-1).frame.payload, "GREETINGS PROFESSOR FALKEN.");
});

test("a link carries the seat token, so the hub knows who to mint for", (t) => {
  const made = withFakeSocket(t);
  new WoprLink({ url: "ws://h/link", surface: "home-terminal",
                 session: "s", token: "t", seat: "TOK1" }).connect();
  assert.match(made[0].url, /seat=TOK1/);
});

// This is the load-bearing case: once a ring is answered, the hub reuses this
// same socket to carry the call, and an unrecognized control payload is the
// hub's ONLY way to say something happened to that call (e.g. it ended). If
// WoprSeat swallowed every control payload it doesn't itself use, nothing
// downstream could ever learn of it. Deliberately NOT "NO CARRIER" here, so
// this proves the general no-filtering rule rather than one hardcoded word.
test("an unrecognized control payload is forwarded as a frame, not swallowed", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.onmessage?.({ data: control("BUSY") });
  assert.equal(events.at(-1).type, "frame");
  assert.equal(events.at(-1).frame.payload, "BUSY");
});

// The specific instance that motivated the rule above: NO CARRIER is how a
// terminal that answered a ring learns the call ended (relay/src/server.ts's
// playOutAndDrop). This is documentation value on top of the general test,
// not a special case in the implementation.
test("NO CARRIER on an answered seat also reaches a listener as a frame", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  seat.answer();
  ws.onmessage?.({ data: control("NO CARRIER") });
  assert.equal(events.at(-1).type, "frame");
  assert.equal(events.at(-1).frame.payload, "NO CARRIER");
});
