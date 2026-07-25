import test from "node:test";
import assert from "node:assert/strict";
import { buildSweep } from "./wardial.ts";

const SYSTEMS = [
  { kind: "system", id: "sys-airline", name: "PAN AM", number: "(212) 555-0177", systemId: "airline" },
  { kind: "system", id: "sys-school", name: "GOOSE LAKE SCHOOL DISTRICT", number: "(206) 555-0142", systemId: "school" },
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

test("has NO CARRIER and BUSY misses; CARRIER<->hit invariant", () => {
  const sweep = buildSweep(SYSTEMS);
  assert.ok(sweep.some((x) => x.status === "NO CARRIER"));
  assert.ok(sweep.some((x) => x.status === "BUSY"));
  for (const x of sweep) {
    if (x.status === "CARRIER") assert.ok(x.hit, "CARRIER entry must have a hit");
    else assert.ok(!x.hit, "non-CARRIER entry must have no hit");
  }
});
