// The consumer end of the shaped link (real-wopr#123): drive the extracted
// frame handler with payloads chunked exactly the way the relay's era shaper
// emits them, and assert what the terminal would end up displaying. Both
// shipped surface bugs lived here — a prompt handler that replaced instead
// of reassembling, and buffers that survived a redial.

import test from "node:test";
import assert from "node:assert/strict";
import { HomeFrameHandler, type FrameEvent, type Phase } from "../src/frames.ts";

// Shape a payload the way the relay does on the wire: emission quanta of
// floor(baud / bits_per_char / 15) bytes — floor(300/10/15) = 2 bytes at
// dialup-300, the home terminal's real profile — with eom only on the final
// quantum (docs/comms-protocol.md §3). The producer side of this contract is
// proven against the real LinkShaper in emulator/relay/tests/shaper.test.ts
// ("framing: a prompt is chunked like any other payload at dialup-300").
// Surfaces and the comms layer are separate modules of the federation and
// share only the wire spec, so this test reproduces the shape from the spec
// instead of importing the relay's shaper. ASCII payloads only, so slicing
// by character equals slicing by byte.
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

/** A recorder standing where page.tsx's React state and peripherals stand. */
function harness(phase: Phase = "connected") {
  const state = {
    phase,
    text: "",
    prompt: ">",
    prompts: [] as string[],
    modem: [] as string[],
    spoken: [] as string[],
  };
  const handler = new HomeFrameHandler({
    getPhase: () => state.phase,
    setPhase: (p) => {
      state.phase = typeof p === "function" ? p(state.phase) : p;
    },
    appendText: (s) => {
      state.text += (state.text === "" || state.text.endsWith("\n") ? "" : "\n") + s;
    },
    appendRaw: (s) => {
      state.text += s;
    },
    setPrompt: (p) => {
      state.prompt = p;
      state.prompts.push(p);
    },
    playModem: (st) => state.modem.push(st),
    speakLine: (l) => state.spoken.push(l),
  });
  return { state, handler };
}

test("regression: a prompt arriving in dialup-300 quanta displays whole", () => {
  // "[TTT]>" crosses the wire as "[T", "TT", "]>". The shipped bug REPLACED
  // per frame, so only the last quantum won and the terminal showed "]>".
  const { state, handler } = harness();
  const frames = shaped("prompt", "[TTT]>");
  assert.ok(frames.length > 1, "a prompt that fits one frame would not prove the hazard");
  for (const e of frames) handler.onEvent(e);
  assert.equal(state.prompt, "[TTT]>");
  // The prompt was set exactly once, whole — never as a bare fragment.
  assert.deepEqual(state.prompts, ["[TTT]>"]);
});

test("a chunked handshake reassembles before the state is parsed", () => {
  const { state, handler } = harness("dialing");
  const frames = shaped("handshake", "CONNECTED WOPR EXCHANGE - SAO PAULO");
  for (const e of frames.slice(0, -1)) handler.onEvent(e);
  // Nothing acts until the message completes.
  assert.deepEqual(state.modem, []);
  assert.equal(state.phase, "dialing");
  handler.onEvent(frames.at(-1)!);
  assert.deepEqual(state.modem, ["CONNECTED"]);
  assert.equal(state.phase, "connected");
  assert.equal(state.text, "\nWOPR EXCHANGE - SAO PAULO\n");
});

test("output streams by appending each quantum; completed lines are spoken", () => {
  const { state, handler } = harness();
  const payload = "GREETINGS PROFESSOR FALKEN.\nSHALL WE PLAY A GAME?\n";
  for (const e of shaped("output", payload)) handler.onEvent(e);
  assert.equal(state.text, payload);
  assert.deepEqual(state.spoken, ["GREETINGS PROFESSOR FALKEN.", "SHALL WE PLAY A GAME?"]);
});

test("regression: a drop mid-prompt must not leak into the next call's prompt", () => {
  // A line drop between a prompt's first and last chunk (~200ms window at
  // 300 baud) strands a fragment. dial() calls resetCall(); without it the
  // fragment prefixes the next call's first prompt.
  const { state, handler } = harness();
  const quanta = shaped("prompt", "[TTT]>");
  handler.onEvent(quanta[0]); // "[T"
  handler.onEvent(quanta[1]); // "TT" — then the carrier drops
  handler.onEvent({ type: "close" });
  handler.resetCall(); // what dial() does on redial
  state.phase = "connected";
  for (const e of shaped("prompt", "[TTT]>")) handler.onEvent(e);
  assert.equal(state.prompt, "[TTT]>");

  // Prove the test discriminates: the same sequence without resetCall()
  // reproduces the leak this guards against.
  const leaky = harness();
  leaky.handler.onEvent(quanta[0]);
  leaky.handler.onEvent(quanta[1]);
  leaky.handler.onEvent({ type: "close" });
  leaky.state.phase = "connected";
  for (const e of shaped("prompt", "[TTT]>")) leaky.handler.onEvent(e);
  assert.equal(leaky.state.prompt, "[TTT[TTT]>");
});

test("a drop mid-handshake must not leak into the next call's handshake", () => {
  const { state, handler } = harness("dialing");
  const quanta = shaped("handshake", "CONNECTED WOPR");
  handler.onEvent(quanta[0]); // "CO" — then the carrier drops
  handler.onEvent({ type: "close" });
  assert.equal(state.phase, "no-carrier");
  handler.resetCall();
  state.phase = "dialing";
  for (const e of shaped("handshake", "NO_CARRIER")) handler.onEvent(e);
  // A leaked "CO" prefix would make the state word "CONO_CARRIER" — neither
  // a label nor a phase change.
  assert.deepEqual(state.modem, ["NO_CARRIER"]);
  assert.equal(state.phase, "no-carrier");
  assert.match(state.text, /NO CARRIER\n$/);
});

test("a control NO CARRIER prints once; the WS close behind it stays silent", () => {
  const { state, handler } = harness();
  handler.onEvent({
    type: "frame",
    frame: { v: 1, session: "s1", seq: 0, kind: "control", link: "dialup-300", payload: "NO CARRIER", eom: true },
  } as FrameEvent);
  assert.equal(state.phase, "no-carrier");
  handler.onEvent({ type: "close" }); // the comms layer closes right after
  assert.equal(state.text.match(/NO CARRIER/g)!.length, 1);
});

test("an unexpected close with no control frame announces NO CARRIER itself", () => {
  const { state, handler } = harness("connected");
  handler.onEvent({ type: "close" });
  assert.equal(state.text, "\n\nNO CARRIER\n");
  assert.equal(state.phase, "no-carrier");
  // Idle close (our own hangup path detaches first, but stay defensive).
  const idle = harness("idle");
  idle.handler.onEvent({ type: "close" });
  assert.equal(idle.state.text, "");
  assert.equal(idle.state.phase, "idle");
});

// The prompt is only ever changed by an arriving prompt frame, so before #26
// nothing reset it when the carrier went away: PANAMAC's "READY:" outlived the
// line it belonged to, and the local console interpreter answered under the
// dead system's prompt. Both carrier-loss paths own the NO CARRIER
// announcement, so both must return the input line to the local console.
test("a control NO CARRIER returns the input line to the local console", () => {
  const { state, handler } = harness();
  for (const e of shaped("prompt", "READY:")) handler.onEvent(e);
  assert.equal(state.prompt, "READY:", "the dialled system owns the prompt while the line is up");
  handler.onEvent({
    type: "frame",
    frame: { v: 1, session: "s1", seq: 9, kind: "control", link: "dialup-300", payload: "NO CARRIER", eom: true },
  } as FrameEvent);
  assert.equal(state.prompt, ">");
});

test("an unexpected close returns the input line to the local console", () => {
  const { state, handler } = harness();
  for (const e of shaped("prompt", "READY:")) handler.onEvent(e);
  assert.equal(state.prompt, "READY:");
  handler.onEvent({ type: "close" });
  assert.equal(state.prompt, ">");
});

// An idle close is not a carrier loss — it prints nothing and changes no
// phase, so it must not touch the prompt either.
test("an idle close leaves the prompt alone", () => {
  const { state, handler } = harness("idle");
  for (const e of shaped("prompt", "LOCAL>")) handler.onEvent(e);
  handler.onEvent({ type: "close" });
  assert.equal(state.prompt, "LOCAL>");
});
