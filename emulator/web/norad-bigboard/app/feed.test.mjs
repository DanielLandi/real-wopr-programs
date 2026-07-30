// The consumer end of the shaped link for the Big Board's JSON feed
// (real-wopr#123): drive the extracted FeedAssembler with a GTW-FEED message
// chunked the way the relay's era shaper emits it, and with the mid-message
// drop that shipped as real-wopr-programs#8 — where a leaked fragment
// corrupts a JSON parse, not just a cosmetic prefix. Deliberate per-surface
// duplicate of wopr-panel's test, like the parser itself.

import test from "node:test";
import assert from "node:assert/strict";
import { FeedAssembler, FEED_PREFIX } from "./feed.ts";

// Shape a payload the way the relay does on the wire: emission quanta of
// floor(baud / bits_per_char / 15) bytes — floor(300/10/15) = 2 bytes at
// dialup-300 — with eom only on the final quantum (docs/comms-protocol.md
// §3). The board listens on the uncapped internal bus, but COMMS_BAUD can
// override any profile, so 300 baud is the adversarial-but-real case. The
// producer side of this contract is proven against the real LinkShaper in
// emulator/relay/tests/shaper.test.ts; surfaces and the comms layer are
// separate modules of the federation and share only the wire spec, so this
// test reproduces the shape from the spec instead of importing the relay's
// shaper. ASCII payloads only, so slicing by character equals slicing by byte.
function shaped(kind, payload, quantum = 2) {
  const frames = [];
  for (let i = 0; i < payload.length; i += quantum) {
    frames.push({
      v: 1,
      session: "s1",
      seq: frames.length,
      kind,
      link: "dialup-300",
      payload: payload.slice(i, i + quantum),
      eom: i + quantum >= payload.length,
    });
  }
  return frames;
}

// A realistic GTW-FEED line, the wire shape the bridge relays to observers.
const FEED_LINE =
  FEED_PREFIX +
  JSON.stringify({
    type: "gtw_state",
    defcon: 2,
    clock: "00:41",
    targets: 36,
    impact: "11:02",
    status: "PLAYING",
    scenario: "US FIRST STRIKE",
    missiles: [{ from: [-104.8, 38.7], to: [37.6, 55.7], progress: 0.7 }],
  });

test("a feed message arriving in dialup-300 quanta parses once, whole", () => {
  const a = new FeedAssembler();
  const frames = shaped("output", FEED_LINE);
  assert.ok(frames.length > 1);
  const results = frames.map((f) => a.push(f));
  assert.ok(results.slice(0, -1).every((r) => r === null));
  const parsed = results.at(-1);
  assert.equal(parsed?.type, "gtw_state");
  assert.equal(parsed?.defcon, 2);
  assert.equal(parsed?.scenario, "US FIRST STRIKE");
});

test("regression: a mid-message drop must not corrupt the next parse", () => {
  // The line drops between a message's first and last chunk; the hook calls
  // reset() before constructing the next WoprLink (fixed untested in
  // real-wopr-programs#8 — this is that test).
  const a = new FeedAssembler();
  const frames = shaped("output", FEED_LINE);
  for (const f of frames.slice(0, 5)) a.push(f); // then the carrier drops
  a.reset(); // what useGtwFeed does on (re)connect
  const results = shaped("output", FEED_LINE).map((f) => a.push(f));
  assert.equal(results.at(-1)?.defcon, 2);

  // Prove the test discriminates: without reset() the stranded fragment
  // prefixes the next message and the JSON parse fails — the shipped bug.
  const leaky = new FeedAssembler();
  for (const f of frames.slice(0, 5)) leaky.push(f);
  const corrupted = shaped("output", FEED_LINE).map((f) => leaky.push(f));
  assert.ok(corrupted.every((r) => r === null));
});

test("handshake frames are ignored — the internal bus has no ritual", () => {
  const a = new FeedAssembler();
  // Even a complete handshake message must not disturb a feed in progress.
  const frames = shaped("output", FEED_LINE);
  a.push(frames[0]);
  for (const f of shaped("handshake", "CONNECTED INTERNAL BUS")) {
    assert.equal(a.push(f), null);
  }
  const results = frames.slice(1).map((f) => a.push(f));
  assert.equal(results.at(-1)?.defcon, 2);
});
