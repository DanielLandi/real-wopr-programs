import test from "node:test";
import assert from "node:assert/strict";
import { WoprLink } from "../src/link.ts";

// A stand-in for the browser's WebSocket, close enough for WoprLink: it
// records instances, starts CONNECTING, and lets a test flip it open or
// closed the way the network would. Restored via t.after.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last = null;
  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.last = this;
  }
  send(data) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
  /** The far end answers: carrier up. */
  answer() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  /** The far end hangs up (SO, or a drop): the socket dies under us. */
  drop() {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

function withFakeWebSocket(t) {
  const prev = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.last = null;
  t.after(() => {
    globalThis.WebSocket = prev;
  });
}

const opts = { url: "ws://exchange.example/link", surface: "home-terminal", session: "s1" };

test("a link that never connected is not open", () => {
  const link = new WoprLink(opts);
  assert.equal(link.open, false);
});

test("a connected link with a live carrier is open", (t) => {
  withFakeWebSocket(t);
  const link = new WoprLink(opts);
  link.connect();
  FakeWebSocket.last.answer();
  assert.equal(link.open, true);
});

test("regression (#27): a link whose far end hung up is not open", (t) => {
  // DIAL 01 → SO → DIAL 01 again stalled at DIALING: dial()'s retry-on-the-
  // same-line shortcut fired on a link whose socket was already closed, and
  // the control DIAL went into the dead socket. A closed link must not
  // qualify as a line to retry on.
  withFakeWebSocket(t);
  const link = new WoprLink(opts);
  link.connect();
  FakeWebSocket.last.answer();
  FakeWebSocket.last.drop();
  assert.equal(link.open, false);
  // And this is why the stall was silent: a send on the dead line is a no-op.
  link.sendControl("DIAL");
  assert.deepEqual(FakeWebSocket.last.sent, []);
});

test("a deliberate hangup leaves the link not open", (t) => {
  withFakeWebSocket(t);
  const link = new WoprLink(opts);
  link.connect();
  FakeWebSocket.last.answer();
  link.hangup();
  assert.equal(link.open, false);
});
