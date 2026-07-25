// Handshake FSM tests (docs/comms-protocol.md §7): the FSM visits each state,
// blocks application frames until CONNECTED, and the NO_CARRIER path is
// reachable on a forced failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runHandshake, type HandshakeState } from "../src/handshake.ts";

test("dialup ritual visits every state in order and connects", async () => {
  const states: HandshakeState[] = [];
  const ok = await runHandshake(
    "dialup", "authentic", 300,
    (s) => states.push(s),
    { timeScale: 0.01, rng: () => 0.5, failRate: 0 },
  );
  assert.equal(ok, true);
  assert.deepEqual(states, ["DIALING", "RINGING", "CARRIER_DETECT", "HANDSHAKE", "CONNECTED"]);
});

test("forced failure reaches NO_CARRIER and does not connect", async () => {
  const states: HandshakeState[] = [];
  const ok = await runHandshake(
    "dialup", "authentic", 300,
    (s) => states.push(s),
    { timeScale: 0.01, rng: () => 0.9, failRate: 1 },
  );
  assert.equal(ok, false);
  assert.equal(states.at(-1), "NO_CARRIER");
  assert.ok(!states.includes("CONNECTED"));
});

test("fast mode collapses to an instant CONNECTED", async () => {
  const states: HandshakeState[] = [];
  const details: string[] = [];
  const t0 = performance.now();
  const ok = await runHandshake(
    "dialup", "fast", 300,
    (s, d) => { states.push(s); details.push(d); },
    { failRate: 1 }, // even a forced failure cannot stop fast mode
  );
  assert.equal(ok, true);
  assert.ok(performance.now() - t0 < 100);
  assert.deepEqual(states, ["CONNECTED"]);
  assert.match(details[0], /^CONNECT /);
});

test("carrier links honor failRate: a lost carrier reaches NO_CARRIER and does not connect", async () => {
  // The leased-line resync path (norad-terminal): with COMMS_FAIL_RATE > 0 a
  // reconnect's carrier handshake can fail, and the surface must get a
  // NO_CARRIER frame to retry from — not a silent hang.
  const states: HandshakeState[] = [];
  const ok = await runHandshake(
    "carrier", "authentic", 9600,
    (s) => states.push(s),
    { timeScale: 0.01, rng: () => 0.5, failRate: 1 },
  );
  assert.equal(ok, false);
  assert.equal(states.at(-1), "NO_CARRIER");
  assert.ok(!states.includes("CONNECTED"));
});

test("carrier links skip the dial ritual; `none` links emit nothing", async () => {
  const states: HandshakeState[] = [];
  const ok = await runHandshake("carrier", "authentic", 9600, (s) => states.push(s), { timeScale: 0.01 });
  assert.equal(ok, true);
  assert.deepEqual(states, ["CARRIER_DETECT", "CONNECTED"]);

  const none: HandshakeState[] = [];
  const ok2 = await runHandshake("none", "authentic", 0, (s) => none.push(s), {});
  assert.equal(ok2, true);
  assert.deepEqual(none, []);
});
