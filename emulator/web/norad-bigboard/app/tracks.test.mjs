import test from "node:test";
import assert from "node:assert/strict";
import { trackRows, targetLine } from "./tracks.ts";

const feed = {
  type: "gtw_state", defcon: 2, clock: "00:30", targets: 1, impact: "18 MIN",
  status: "PLAYING", scenario: "US/USSR EXCHANGE",
  missiles: [{ from: [-77, 39], to: [37, 56], progress: 0.4 }],
  aircraft: [{ id: "B-52-01", side: "US", from: [-100, 42], to: [37, 56], progress: 0.5 }],
  ships: [{ id: "KIEV-01", side: "SU", from: [35, 70], to: [-20, 65], progress: 0.5 }],
  targetStates: [{ name: "LENINGRAD", side: "SU", position: [30, 60], status: "hit" }],
  events: ["HIT LENINGRAD"],
};

test("trackRows: aircraft, ships, then numbered missiles", () => {
  const rows = trackRows(feed);
  assert.deepEqual(rows.map((r) => r.id), ["B-52-01", "KIEV-01", "MSL-01"]);
  assert.deepEqual(rows.map((r) => r.typ), ["AC", "SHIP", "MSL"]);
  assert.equal(rows[2].progress, 0.4);
});

test("trackRows: empty feed yields no rows", () => {
  assert.deepEqual(trackRows({ ...feed, missiles: [], aircraft: [], ships: [] }), []);
});

test("targetLine summarizes struck targets, null when none", () => {
  assert.equal(targetLine(feed), "TARGETS: LENINGRAD HIT");
  assert.equal(targetLine({ ...feed, targetStates: [] }), null);
});
