// The line's own view of whether it is still a line. home-terminal's dial()
// has a retry-on-the-same-line shortcut for redialling the system you are
// already on; before #27 it tested only that a WoprLink object existed, and
// nothing nulled that object when the socket closed. So after a hang-up the
// shortcut fired, sendEnvelope dropped the control frame on a CLOSED socket
// (silently, by design), and the dial never happened — the terminal sat at
// DIALING forever, on the one system a visitor is most likely to retry.

import test from "node:test";
import assert from "node:assert/strict";
import { WoprLink } from "../src/link.ts";

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

function dialled(t) {
  const made = withFakeSocket(t);
  const link = new WoprLink({
    url: "wss://exchange.example/link",
    surface: "home-terminal",
    session: "s1",
  });
  link.connect();
  return { link, socket: made[0] };
}

test("a link is not open until the far end accepts it", (t) => {
  const { link } = dialled(t);
  assert.equal(link.isOpen(), false, "CONNECTING is not a line you can retry a dial on");
});

test("a link is open once the carrier is up", (t) => {
  const { link, socket } = dialled(t);
  socket.accept();
  assert.equal(link.isOpen(), true);
});

test("a link whose carrier dropped is no longer a line to retry a dial on", (t) => {
  const { link, socket } = dialled(t);
  socket.accept();
  socket.dropCarrier();
  assert.equal(link.isOpen(), false);
});

test("a link we hung up ourselves is no longer a line to retry a dial on", (t) => {
  const { link, socket } = dialled(t);
  socket.accept();
  link.hangup();
  assert.equal(link.isOpen(), false);
  assert.equal(socket.readyState, CLOSED);
});

// The guard the whole fix rests on: a control frame sent down a closed socket
// is discarded without error, which is why the stalled dial was silent.
test("a control signal on a dropped line is discarded, not delivered", (t) => {
  const { link, socket } = dialled(t);
  socket.accept();
  socket.dropCarrier();
  link.sendControl("DIAL");
  assert.deepEqual(socket.sent, [], "nothing reaches a closed socket");
});
