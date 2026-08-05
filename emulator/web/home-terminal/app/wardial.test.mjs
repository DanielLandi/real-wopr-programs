import test from "node:test";
import assert from "node:assert/strict";
import { buildSweep, hitListText, RESULTS_HEADER } from "./wardial.ts";
import { DEFAULT_WOPR_NUMBER } from "./console.ts";
import { DIAL_SYSTEMS, WARDIAL_LABELS } from "./sims.ts";

const SYSTEMS = [
  { kind: "system", id: "sys-airline", name: "PAN AM", number: "(212) 555-0177", systemId: "airline" },
  { kind: "system", id: "sys-school", name: "SEATTLE SCHOOL DISTRICT", number: "(206) 555-0142", systemId: "school-mon" },
  { kind: "system", id: "sys-protovision", name: "PROTOVISION", number: "(408) 555-0163", systemId: "protovision" },
  { kind: "system", id: "sys-pactel", name: "PACIFIC TELEPHONE", number: "(311) 555-0100", systemId: "pactel" },
];

test("buildSweep is deterministic", () => {
  assert.deepEqual(buildSweep(SYSTEMS), buildSweep(SYSTEMS));
});

test("every input system is a labeled CARRIER hit", () => {
  const sweep = buildSweep(SYSTEMS);
  for (const s of SYSTEMS) {
    const e = sweep.find((x) => x.hit && x.hit.target && x.hit.target.systemId === s.systemId);
    assert.ok(e, `missing hit for ${s.systemId}`);
    assert.equal(e.status, "CARRIER");
    assert.ok(e.hit.label && e.hit.label !== "??? NO ANSWERBACK");
  }
});

test("exactly one unknown WOPR hit (target null)", () => {
  const sweep = buildSweep(SYSTEMS);
  const unknown = sweep.filter((x) => x.hit && x.hit.target === null);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].status, "CARRIER");
  assert.equal(unknown[0].hit.label, "??? NO ANSWERBACK");
});

test("the unknown hit is dialled at WOPR's own number", () => {
  const unknown = buildSweep(SYSTEMS).find((x) => x.hit && x.hit.target === null);
  assert.equal(unknown.number, "(311) 399-2364");
  assert.equal(unknown.number, DEFAULT_WOPR_NUMBER);
});

test("the hit list is printed under the film's results header", () => {
  const carriers = buildSweep(SYSTEMS).filter((e) => e.status === "CARRIER");
  const text = hitListText(carriers);
  assert.equal(RESULTS_HEADER, "NUMBERS FOR WHICH CARRIER TONES WERE DETECTED");
  assert.ok(text.includes(RESULTS_HEADER), "results header missing");
  const lines = text.split("\n");
  const header = lines.findIndex((l) => l === RESULTS_HEADER);
  const first = lines.findIndex((l) => l.startsWith("01  "));
  assert.ok(header >= 0 && first >= 0, "header and hit list must both appear");
  assert.ok(header < first, "the header must sit above the hit list");
  // every carrier is listed, numbered, with its number and label
  assert.equal(lines.filter((l) => /^\d\d {2}\(/.test(l)).length, carriers.length);
  assert.ok(text.includes(`${carriers.length} CARRIERS FOUND`));
  assert.ok(text.includes("DIAL <NN> TO CONNECT TO A CARRIER"));
});

test("has NO CARRIER and BUSY misses; CARRIER<->hit invariant", () => {
  const sweep = buildSweep(SYSTEMS);
  assert.ok(sweep.some((x) => x.status === "NO CARRIER"));
  assert.ok(sweep.some((x) => x.status === "BUSY"));
  for (const x of sweep) {
    if (x.status === "CARRIER") assert.ok(x.hit, "CARRIER entry must have a hit");
    else assert.ok(!x.hit, "non-CARRIER entry must have no hit");
  }
});

test("the sweep labels every real carrier, so the CARRIER fallback is unreachable", () => {
  // buildSweep does `LABELS[s.systemId] ?? "CARRIER"`. That fallback is why a
  // stale key never surfaced: the sweep just printed a bare CARRIER and
  // carried on. Driving it with the real directory proves every listed system
  // has a label, which makes the fallback dead code for real hits.
  for (const entry of buildSweep(DIAL_SYSTEMS)) {
    if (entry.status !== "CARRIER" || !entry.hit?.target) continue;
    assert.notEqual(entry.hit.label, "CARRIER", `${entry.hit.target.systemId} fell back to a bare CARRIER`);
    assert.equal(entry.hit.label, WARDIAL_LABELS[entry.hit.target.systemId]);
  }
});
