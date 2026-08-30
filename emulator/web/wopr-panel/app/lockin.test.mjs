// The S13 reveal order, read off the wire (real-wopr#208 / #103): the
// cabinet's lock-in state is a function of the last complete GTW-FEED
// message, so walk the E13 frame sequence — idle at 5, running at 2 and 1,
// then NO-WIN holding — through the real FeedAssembler and check what the
// readout and the lamps would show at each message. The frames reproduce the
// bridge's wire shape (emulator/node/app/gtwfeed.py) at dialup-300 quanta,
// exactly as feed.test.mjs does; the scenario is
// real-wopr/evals/scenarios/e13-cabinet-feed.json.

import test from "node:test";
import assert from "node:assert/strict";
import { FeedAssembler, FEED_PREFIX } from "./feed.ts";
import { CODE, CODE_SLOTS, LOCKS_BY_DEFCON, agitation, lockin } from "./lockin.ts";

function feedLine(defcon, status, phase) {
  return (
    FEED_PREFIX +
    JSON.stringify({
      type: "gtw_state",
      phase,
      defcon,
      clock: "00:10",
      targets: (5 - defcon) * 12,
      impact: status === "NO-WIN" ? null : "23 MIN",
      status,
      scenario: "US/USSR EXCHANGE",
      missiles: phase === "running" ? [{ from: [37.6, 55.7], to: [-104.8, 38.7], progress: 0.4 }] : [],
    })
  );
}

function shaped(payload, quantum = 2) {
  const frames = [];
  for (let i = 0; i < payload.length; i += quantum) {
    frames.push({ kind: "output", payload: payload.slice(i, i + quantum), eom: i + quantum >= payload.length });
  }
  return frames;
}

// E13's observed frames: first/final of each panel step, in order.
const E13 = [
  feedLine(5, "PLAYING", "idle"),
  feedLine(2, "PLAYING", "running"),
  feedLine(1, "PLAYING", "running"),
  feedLine(1, "NO-WIN", "no-win"),
  feedLine(1, "NO-WIN", "no-win"),
];

/** Derive the panel's state after each complete message of a sequence,
 *  chunk by chunk through the assembler — one entry per feed line. */
function walk(lines) {
  const assembler = new FeedAssembler();
  let live = null;
  const states = [];
  for (const line of lines) {
    for (const frame of shaped(line)) {
      const parsed = assembler.push(frame);
      if (parsed) live = parsed;
    }
    states.push(lockin(live));
  }
  return states;
}

test("standby: nothing observed reads DEFCON 5, nothing locked, no abort", () => {
  assert.deepEqual(lockin(null), { defcon: 5, aborted: false, locked: 0 });
});

test("E13: the reveal runs lamps -> lock-in -> abort, in that order", () => {
  const [idle, running2, running1, noWin, held] = walk(E13);
  assert.deepEqual(idle, { defcon: 5, aborted: false, locked: 0 });
  assert.deepEqual(running2, { defcon: 2, aborted: false, locked: 8 });
  // At DEFCON 1 the code is complete but the launch is still enabled — the
  // abort is the routine's verdict, not a consequence of the last lock.
  assert.deepEqual(running1, { defcon: 1, aborted: false, locked: CODE_SLOTS.length });
  assert.deepEqual(noWin, { defcon: 1, aborted: true, locked: CODE_SLOTS.length });
  assert.deepEqual(held, noWin, "NO-WIN holds across repeated frames");
});

test("E13: locked count never falls and DEFCON never rises while the feed runs", () => {
  const states = walk(E13);
  for (let i = 1; i < states.length; i += 1) {
    assert.ok(states[i].locked >= states[i - 1].locked, `locks fell at message ${i}`);
    assert.ok(states[i].defcon <= states[i - 1].defcon, `DEFCON rose at message ${i}`);
  }
});

test("the full walk 5 -> 1 locks characters in the table's steps, then the abort locks the rest", () => {
  const walkAll = [4, 3, 2, 1].map((d) => feedLine(d, "PLAYING", d < 5 ? "running" : "idle"));
  const states = walk([feedLine(5, "PLAYING", "idle"), ...walkAll, feedLine(1, "NO-WIN", "no-win")]);
  assert.deepEqual(
    states.map((s) => s.locked),
    [5, 4, 3, 2, 1].map((d) => LOCKS_BY_DEFCON[d]).concat(CODE_SLOTS.length),
  );
  // An abort from higher up the ladder still locks the whole code at once.
  assert.deepEqual(lockin({ defcon: 3, status: "NO-WIN" }), { defcon: 3, aborted: true, locked: CODE_SLOTS.length });
});

test("a DEFCON outside the table locks nothing rather than throwing", () => {
  assert.equal(lockin({ defcon: 0, status: "PLAYING" }).locked, 0);
  assert.equal(lockin({ defcon: 9, status: "PLAYING" }).locked, 0);
});

test("CODE_SLOTS is a fixed permutation of the code's non-space positions", () => {
  const expected = [...CODE].map((ch, i) => (ch === " " ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual([...CODE_SLOTS].sort((a, b) => a - b), expected);
  assert.equal(CODE_SLOTS.length, 10);
  assert.notDeepEqual(CODE_SLOTS, expected, "the brute force is not meant to read left to right");
  // Pinned: the readout's reveal order is part of the scene, not incidental.
  assert.deepEqual(CODE_SLOTS, [6, 4, 11, 9, 1, 7, 0, 2, 5, 10]);
});

test("lamp agitation: faster epochs and more lamps as DEFCON falls, more again at abort", () => {
  const tick = 120;
  const states = [5, 4, 3, 2, 1].map((defcon) => agitation(lockin({ defcon, status: "PLAYING" }), tick));
  for (let i = 1; i < states.length; i += 1) {
    assert.ok(states[i].epoch >= states[i - 1].epoch, `epoch slowed at step ${i}`);
    assert.ok(states[i].density > states[i - 1].density, `density fell at step ${i}`);
  }
  const calm = agitation(lockin({ defcon: 1, status: "PLAYING" }), tick);
  const abort = agitation(lockin({ defcon: 1, status: "NO-WIN" }), tick);
  assert.ok(abort.density > calm.density);
  assert.equal(abort.epoch, tick, "at abort the epoch runs every tick");
  // An abort higher on the ladder (the routine can give up at any DEFCON)
  // still quickens the lamps, not just brightens them.
  const abortedAt4 = agitation(lockin({ defcon: 4, status: "NO-WIN" }), tick);
  assert.ok(abortedAt4.epoch > agitation(lockin({ defcon: 4, status: "PLAYING" }), tick).epoch);
  assert.equal(agitation(lockin(null), 0).epoch, 0);
});
