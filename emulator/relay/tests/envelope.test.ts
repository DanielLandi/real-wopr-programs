// Envelope codec tests (docs/comms-protocol.md §5): the wire schema and its
// fixed set of valid frame kinds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEnvelope } from "../src/envelope.ts";

test("a prompt frame is a valid kind", () => {
  const frame = JSON.stringify({
    v: 1, session: "s", seq: 1, kind: "prompt",
    link: "dialup-300", payload: "[TTT]>", eom: true,
  });
  const decoded = decodeEnvelope(frame);
  assert.equal(decoded?.kind, "prompt");
  assert.equal(decoded?.payload, "[TTT]>");
});
