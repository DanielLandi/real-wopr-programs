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

// --- reconnect --------------------------------------------------------------
// "A seat outlives every call" is the load-bearing claim of the whole callback
// design, and it was true only of calls — not of the seat's own socket. A
// tunnel blip or an exchange redeploy ended the seat for the life of the page,
// and the visitor saw nothing: they could still dial out, they simply could
// never be rung back again (#78 item 1).

const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 30_000;

/** Drive a fake socket through a full seating: open, SEAT?, SEAT <token>. */
function seatIt(ws, token) {
  ws.readyState = OPEN;
  ws.onopen?.();
  ws.onmessage?.({ data: control(`SEAT ${token}`) });
}

test("a dropped seat forgets its token at once", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  seatIt(made[0], "TOK1");
  assert.equal(seat.token, "TOK1");

  made[0].dropCarrier();

  // The half of the fix that matters even if every reconnect fails: page.tsx
  // reads seat.token per dial, so an undefined one omits ?seat= and the
  // visitor honestly dials a call that cannot be rung back. A token minted
  // against a leg the hub has reaped mints nothing, and costs a refusal.
  assert.equal(seat.token, undefined,
    "a stale token is strictly worse than no token");
});

test("a dropped seat redials and asks for a new token", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  seatIt(made[0], "TOK1");
  made[0].dropCarrier();

  assert.equal(made.length, 1, "the redial waits out the backoff, it does not spin");
  t.mock.timers.tick(RETRY_BASE_MS);
  assert.equal(made.length, 2, "a dropped seat must come back");

  // A reconnect is a full re-handshake: there is no resume verb in the /seat
  // vocabulary, and the hub never volunteers a token.
  made[1].readyState = OPEN;
  made[1].onopen?.();
  assert.deepEqual(made[1].sent.map((s) => JSON.parse(s).payload), ["SEAT?"]);
  made[1].onmessage?.({ data: control("SEAT TOK2") });
  assert.equal(seat.token, "TOK2", "the new leg's token replaces the reaped one");
});

test("a drop is still announced, so the call riding it is not left on screen", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  seatIt(made[0], "TOK1");
  made[0].dropCarrier();

  // Reconnecting repairs the seat, not the call that was riding it. A visitor
  // mid-ring or on an answered callback must still be returned to the prompt.
  assert.deepEqual(events.map((e) => e.type), ["seated", "close"]);
});

test("the backoff doubles and then holds at its ceiling", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();

  // Never seated: every attempt fails the same way an exchange that is down
  // fails, which is the case the schedule exists for.
  const waited = [];
  for (let i = 0; i < 8; i++) {
    const before = made.length;
    made[before - 1].dropCarrier();
    // Find the delay by ticking one ms at a time would be slow; tick the
    // expected amount minus one, assert nothing happened, then the last ms.
    const expect = Math.min(RETRY_BASE_MS * 2 ** i, RETRY_MAX_MS);
    t.mock.timers.tick(expect - 1);
    assert.equal(made.length, before, `attempt ${i + 1} fired before ${expect}ms`);
    t.mock.timers.tick(1);
    assert.equal(made.length, before + 1, `attempt ${i + 1} did not fire at ${expect}ms`);
    waited.push(expect);
  }
  assert.deepEqual(waited, [750, 1500, 3000, 6000, 12000, 24000, 30000, 30000],
    "the interval is capped; the attempt count deliberately is not");
});

test("a seating resets the backoff — a socket that never seats does not", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();

  made[0].dropCarrier();
  t.mock.timers.tick(RETRY_BASE_MS);            // attempt 2
  // Opened, but the hub's 4408 handshake timer closes it before a token: not
  // a working seat, so this must NOT count as recovery.
  made[1].readyState = OPEN;
  made[1].onopen?.();
  made[1].dropCarrier();
  t.mock.timers.tick(RETRY_BASE_MS);
  assert.equal(made.length, 2, "an open socket that never seated is not recovery");
  t.mock.timers.tick(RETRY_BASE_MS);            // 1500ms total -> attempt 3
  assert.equal(made.length, 3);

  seatIt(made[2], "TOK1");                      // this one works
  made[2].dropCarrier();
  t.mock.timers.tick(RETRY_BASE_MS);
  assert.equal(made.length, 4, "a token is the only proof the seat works, and it resets the schedule");
});

test("close() ends the seat for good and cancels a redial in flight", (t) => {
  const made = withFakeSocket(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  seatIt(made[0], "TOK1");
  made[0].dropCarrier();          // a redial is now pending
  seat.close();                   // ...and the page unmounts
  t.mock.timers.tick(RETRY_MAX_MS * 2);
  assert.equal(made.length, 1, "an unmounted page must leave no timer behind");

  // And a deliberate close of a live seat schedules nothing either.
  const again = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  again.connect();
  seatIt(made[1], "TOK9");
  again.close();
  made[1].onclose?.();            // what a browser does after close()
  t.mock.timers.tick(RETRY_MAX_MS * 2);
  assert.equal(made.length, 2);
});
