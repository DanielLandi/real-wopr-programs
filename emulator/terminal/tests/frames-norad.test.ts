// The consumer end of the shaped link (real-wopr#123): drive the extracted
// frame handler with payloads chunked the way the relay's era shaper emits
// them, and assert what the console would end up doing. This console's
// historical hazard was a handshake test against a single frame's payload
// (f.eom && f.payload.includes("CONNECTED")) — correct only while the link
// profile's quantum is wider than the message.

import test from "node:test";
import assert from "node:assert/strict";
import { NoradFrameHandler, type FrameEvent } from "../src/frames.ts";

// Shape a payload the way the relay does on the wire: emission quanta of
// floor(baud / bits_per_char / 15) bytes — floor(300/10/15) = 2 bytes at
// dialup-300 — with eom only on the final quantum (docs/comms-protocol.md
// §3). This console rides leased-9600, whose quantum is wide, but COMMS_BAUD
// can override any profile, so 300 baud is the adversarial-but-real case.
// The producer side of this contract is proven against the real LinkShaper
// in emulator/relay/tests/shaper.test.ts; surfaces and the comms layer are
// separate modules of the federation and share only the wire spec, so this
// test reproduces the shape from the spec instead of importing the relay's
// shaper. ASCII payloads only, so slicing by character equals slicing by byte.
function shaped(kind: string, payload: string, quantum = 2): FrameEvent[] {
  const frames: FrameEvent[] = [];
  for (let i = 0; i < payload.length; i += quantum) {
    frames.push({
      type: "frame",
      frame: {
        v: 1,
        session: "s1",
        seq: frames.length,
        kind,
        link: "dialup-300",
        payload: payload.slice(i, i + quantum),
        eom: i + quantum >= payload.length,
      },
    } as FrameEvent);
  }
  return frames;
}

/** A recorder standing where page.tsx's React state, refs and timers stand. */
function harness() {
  const state = {
    phase: "connecting",
    text: "",
    prompt: "WOPR>",
    prompts: [] as string[],
    reconnectsScheduled: 0,
    redialsScheduled: 0,
    recoveriesReset: 0,
    disposed: false,
  };
  const handler = new NoradFrameHandler({
    isDisposed: () => state.disposed,
    setPhase: (p) => {
      state.phase = p;
    },
    appendLine: (s) => {
      state.text += (state.text.endsWith("\n") || state.text === "" ? "" : "\n") + s;
    },
    appendRaw: (s) => {
      state.text += s;
    },
    setPrompt: (p) => {
      state.prompt = p;
      state.prompts.push(p);
    },
    scheduleReconnect: () => {
      state.reconnectsScheduled += 1;
    },
    scheduleRedial: () => {
      state.redialsScheduled += 1;
    },
    resetRecoveries: () => {
      state.recoveriesReset += 1;
    },
  });
  return { state, handler };
}

test("regression: a chunked CONNECTED handshake still connects", () => {
  // No single quantum contains "CONNECTED", so the pre-reassembly test
  // (f.eom && f.payload.includes("CONNECTED")) would never match and the
  // console would sit at SYNC forever.
  const { state, handler } = harness();
  const frames = shaped("handshake", "CONNECTED NORAD TIE LINE");
  assert.ok(frames.every((e) => !(e as { frame: { payload: string } }).frame.payload.includes("CONNECTED")));
  for (const e of frames.slice(0, -1)) handler.onEvent(e);
  assert.equal(state.phase, "connecting"); // nothing acts before eom
  handler.onEvent(frames.at(-1)!);
  assert.equal(state.phase, "connected");
  assert.equal(state.recoveriesReset, 1);
});

test("regression: a prompt arriving in quanta displays whole", () => {
  const { state, handler } = harness();
  for (const e of shaped("prompt", "[TTT]>")) handler.onEvent(e);
  assert.equal(state.prompt, "[TTT]>");
  assert.deepEqual(state.prompts, ["[TTT]>"]); // never a bare fragment
});

test("output streams by appending each quantum", () => {
  const { state, handler } = harness();
  const payload = "LOGON: ";
  for (const e of shaped("output", payload)) handler.onEvent(e);
  assert.equal(state.text, payload);
});

test("a drop mid-handshake must not leak into the reconnect's handshake", () => {
  // connectLink() calls resetLink() before opening the new link. A leaked
  // "CO" prefix would turn the next "NO_CARRIER" into "CONO_CARRIER" —
  // neither a connect nor a retry, a console stuck at RESYNC.
  const { state, handler } = harness();
  const quanta = shaped("handshake", "CONNECTED NORAD TIE LINE");
  handler.onEvent(quanta[0]); // "CO" — then the line drops
  handler.onEvent({ type: "close" });
  assert.equal(state.phase, "reconnecting");
  assert.equal(state.reconnectsScheduled, 1);
  handler.resetLink(); // what connectLink() does
  for (const e of shaped("handshake", "NO_CARRIER")) handler.onEvent(e);
  assert.equal(state.phase, "reconnecting");
  assert.equal(state.redialsScheduled, 1);
  assert.match(state.text, /CARRIER LOST - RETRYING\n$/);

  // Prove the test discriminates: without resetLink() the fragment leaks and
  // the console does nothing at all with the reassembled mutant.
  const leaky = harness();
  leaky.handler.onEvent(quanta[0]);
  leaky.handler.onEvent({ type: "close" });
  for (const e of shaped("handshake", "NO_CARRIER")) leaky.handler.onEvent(e);
  assert.equal(leaky.state.redialsScheduled, 0); // stuck — the shipped bug
});

test("WS-close retry budget: three resyncs, then down", () => {
  const { state, handler } = harness();
  for (let i = 0; i < 3; i++) handler.onEvent({ type: "close" });
  assert.equal(state.reconnectsScheduled, 3);
  assert.equal(state.phase, "reconnecting");
  handler.onEvent({ type: "close" });
  assert.equal(state.phase, "down");
  assert.equal(state.reconnectsScheduled, 3);
  // A live CONNECTED clears the budget for future faults.
  const fresh = harness();
  fresh.handler.onEvent({ type: "close" });
  for (const e of shaped("handshake", "CONNECTED NORAD TIE LINE")) fresh.handler.onEvent(e);
  fresh.handler.onEvent({ type: "close" });
  assert.equal(fresh.state.reconnectsScheduled, 2);
  assert.equal(fresh.state.phase, "reconnecting");
});

test("a close after disposal does nothing", () => {
  const { state, handler } = harness();
  state.disposed = true;
  handler.onEvent({ type: "close" });
  assert.equal(state.phase, "connecting");
  assert.equal(state.reconnectsScheduled, 0);
});

test("a control NO CARRIER prints on its own line", () => {
  const { state, handler } = harness();
  for (const e of shaped("output", "LOGON: ")) handler.onEvent(e);
  handler.onEvent({
    type: "frame",
    frame: { v: 1, session: "s1", seq: 9, kind: "control", link: "dialup-300", payload: "NO CARRIER", eom: true },
  } as FrameEvent);
  assert.equal(state.text, "LOGON: \nNO CARRIER\n");
});
