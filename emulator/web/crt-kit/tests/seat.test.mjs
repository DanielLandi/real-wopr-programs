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

const control = (payload) => JSON.stringify({
  v: 1, session: "x", seq: 0, kind: "control", link: "seat", payload, eom: true,
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
