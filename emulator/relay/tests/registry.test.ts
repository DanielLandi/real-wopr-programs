// Address registry tests: who answers which line, and who is allowed to reach
// them. The registry is the frame room — it knows which wire pair is whose.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Registry, normalizeAddress } from "../src/registry.ts";
import type { AddressClaim } from "../src/node-proto.ts";

function fakePort() {
  const sent: string[] = [];
  return { sent, send(d: string) { sent.push(d); }, close() {} };
}

const PSTN = { name: "pstn", addressing: "phone" as const };
const BUS = { name: "bus", addressing: "name" as const };

function claim(network: string, address: string): AddressClaim {
  return { network, address, protocol: "SYSTEM/1" };
}

test("registry: a node claiming a free line keeps it", () => {
  const r = new Registry({ pstn: PSTN });
  const res = r.claim("school", [claim("pstn", "(206) 555-0142")], fakePort());
  assert.equal(res.ok, true);
  assert.equal(r.lookup("pstn", "(206) 555-0142")?.node, "school");
});

test("registry: a second node claiming the same line is rejected, the first keeps it", () => {
  const r = new Registry({ pstn: PSTN });
  r.claim("school", [claim("pstn", "(206) 555-0142")], fakePort());
  const res = r.claim("impostor", [claim("pstn", "(206) 555-0142")], fakePort());
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /already/);
  assert.equal(r.lookup("pstn", "(206) 555-0142")?.node, "school");
});

test("registry: a node re-registering replaces its own claim rather than colliding", () => {
  // A node that reconnects after a restart must get its line back.
  const r = new Registry({ pstn: PSTN });
  r.claim("school", [claim("pstn", "(206) 555-0142")], fakePort());
  const second = fakePort();
  const res = r.claim("school", [claim("pstn", "(206) 555-0142")], second);
  assert.equal(res.ok, true);
  assert.equal(r.lookup("pstn", "(206) 555-0142")?.port, second);
});

test("registry: phone addresses are one line however they are punctuated", () => {
  const r = new Registry({ pstn: PSTN });
  r.claim("school", [claim("pstn", "(206) 555-0142")], fakePort());
  assert.equal(r.lookup("pstn", "206-555-0142")?.node, "school");
  assert.equal(r.lookup("pstn", "2065550142")?.node, "school");
});

test("registry: name addresses compare case-insensitively", () => {
  const r = new Registry({ bus: BUS });
  r.claim("school-db", [claim("bus", "SCHOOL-DB")], fakePort());
  assert.equal(r.lookup("bus", "school-db")?.node, "school-db");
});

test("registry: the same address on two networks is two different lines", () => {
  const r = new Registry({ pstn: PSTN, bus: BUS });
  const a = r.claim("school", [claim("pstn", "SHARED")], fakePort());
  const b = r.claim("school-db", [claim("bus", "SHARED")], fakePort());
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
});

test("registry: a claim on an undeclared network is rejected", () => {
  const r = new Registry({ pstn: PSTN });
  const res = r.claim("ghost", [claim("norad", "GHOST")], fakePort());
  assert.equal(res.ok, false);
});

test("registry: releasing a node frees every line it held", () => {
  const r = new Registry({ pstn: PSTN, bus: BUS });
  r.claim("school", [claim("pstn", "(206) 555-0142"), claim("bus", "SCHOOL")], fakePort());
  r.release("school");
  assert.equal(r.lookup("pstn", "(206) 555-0142"), null);
  assert.equal(r.lookup("bus", "SCHOOL"), null);
});

test("registry: a rejected claim leaves none of its other lines claimed", () => {
  // All or nothing: a half-registered node would answer some of its addresses
  // and not others, which is worse than not being up at all.
  const r = new Registry({ pstn: PSTN, bus: BUS });
  r.claim("school", [claim("pstn", "(206) 555-0142")], fakePort());
  const res = r.claim("other", [claim("bus", "OTHER"), claim("pstn", "(206) 555-0142")], fakePort());
  assert.equal(res.ok, false);
  assert.equal(r.lookup("bus", "OTHER"), null);
});

test("registry: callable_by is consulted on the callee, not the caller", () => {
  const r = new Registry({ bus: BUS });
  r.claim("school-db", [claim("bus", "SCHOOL-DB")], fakePort(), { callableBy: ["school"] });
  r.claim("school", [claim("bus", "SCHOOL")], fakePort());
  r.claim("airline", [claim("bus", "AIRLINE")], fakePort());
  assert.equal(r.permits("school", "school-db"), true);
  assert.equal(r.permits("airline", "school-db"), false);
});

test("registry: a node with no callable_by is reachable by anyone sharing its network", () => {
  const r = new Registry({ bus: BUS });
  r.claim("reference", [claim("bus", "REFERENCE")], fakePort());
  assert.equal(r.permits("anyone", "reference"), true);
});

test("registry: an unknown callee permits nothing", () => {
  const r = new Registry({ bus: BUS });
  assert.equal(r.permits("school", "ghost"), false);
});

test("normalizeAddress: digits for phone, upper for everything else", () => {
  assert.equal(normalizeAddress("(206) 555-0142", "phone"), "2065550142");
  assert.equal(normalizeAddress(" school-db ", "name"), "SCHOOL-DB");
  assert.equal(normalizeAddress("wopr", "hostname"), "WOPR");
});
