// World/slot placement rules (worlds-directory spec, phase 1). Pure
// Switchboard-level tests with fake ports; the wire is Task 3's suite.
//
// World 1 is RESERVED by default (it is the flagship's). The pre-reservation
// tests below are about placement arithmetic, not about reservation, so they
// construct `new Switchboard({ reservedWorlds: [] })` to keep their original
// semantics; the reservation rules get their own cases at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Switchboard, type TrunkFrame } from "../src/trunk.ts";

const fakePort = () => ({ sent: [] as string[], send(d: string) { this.sent.push(d); }, close() {} });
const reg = (extra: Partial<Extract<TrunkFrame, { t: "REGISTER" }>> = {}) =>
  ({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period", ...extra }) as
  Extract<TrunkFrame, { t: "REGISTER" }>;
const place = (sb: Switchboard, extra = {}) => {
  const r = sb.register(fakePort(), reg(extra));
  assert.equal(typeof r, "object", `expected placement, got ${String(r)}`);
  return r as { code: string; world: number; slot: string };
};

test("no slot requested -> wildcards in world 1, overflow opens world 2", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  assert.deepEqual([place(sb).slot, place(sb).slot], ["OTHER-1", "OTHER-2"]);
  const third = place(sb);
  assert.equal(third.world, 2);
  assert.equal(third.slot, "OTHER-1");
});

test("same named slot lands in successive worlds", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);
  assert.equal(place(sb, { slot: "WOPR" }).world, 2);
  assert.equal(place(sb, { slot: "SCHOOL" }).world, 1);
});

test("world NEW skips live worlds; explicit world joins or refuses", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  place(sb, { slot: "WOPR" });                                   // world 1
  assert.equal(place(sb, { world: "NEW", slot: "WOPR" }).world, 2);
  assert.equal(place(sb, { world: 2, slot: "SCHOOL" }).world, 2);
  assert.equal(sb.register(fakePort(), reg({ world: 2, slot: "SCHOOL" })), "slot-taken");
  assert.equal(sb.register(fakePort(), reg({ world: 99, slot: "SCHOOL" })), "no-circuits");
  // Below the floor as well as above the cap: world 0 never gets placed.
  assert.equal(sb.register(fakePort(), reg({ world: 0, slot: "SCHOOL" })), "no-circuits");
});

test("world cap refuses with no-circuits", () => {
  const sb = new Switchboard({ reservedWorlds: [], maxWorlds: 2 });
  place(sb, { slot: "WOPR" }); place(sb, { slot: "WOPR" });
  assert.equal(sb.register(fakePort(), reg({ slot: "WOPR" })), "no-circuits");
  assert.equal(sb.register(fakePort(), reg({ world: "NEW" })), "no-circuits");
});

test("disconnect frees the slot and evaporates the world; world 1 is pinned", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = place(sb, { slot: "WOPR" });
  const b = place(sb, { slot: "WOPR" });                          // world 2
  sb.unregister(b.code);
  assert.deepEqual(sb.directory("http://hub").map((w) => w.n), [1]);
  sb.unregister(a.code);
  assert.deepEqual(sb.directory("http://hub"), [{ n: 1, slots: [] }]);
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);             // reclaimable
});

test("directory groups by world and orders slots by roster", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  place(sb, { slot: "SCHOOL" });
  place(sb, { slot: "WOPR" });
  place(sb, { world: "NEW", slot: "HOME" });
  const dir = sb.directory("http://hub");
  assert.deepEqual(dir.map((w) => w.n), [1, 2]);
  assert.deepEqual(dir[0].slots.map((e) => e.slot), ["WOPR", "SCHOOL"]);
  assert.deepEqual(dir[1].slots.map((e) => e.slot), ["HOME"]);
  const e = dir[0].slots[0];
  assert.equal(e.world, 1);
  assert.equal(e.api, `http://hub/x/${e.id.slice("trunk-".length).toUpperCase()}`);
});

// ---- reserved worlds --------------------------------------------------------
// World 1 is the flagship's. By default it is closed outright: with no hub key
// configured NOTHING unlocks it, so it is skipped by every automatic placement
// and refused outright when asked for by name.

test("reserved by default: auto placement skips world 1 entirely", () => {
  const sb = new Switchboard();
  const first = place(sb);
  assert.deepEqual([first.world, first.slot], [2, "OTHER-1"]);
  assert.equal(place(sb, { slot: "WOPR" }).world, 2);
});

test("reserved by default: an explicit world 1 is refused world-reserved", () => {
  const sb = new Switchboard();
  assert.equal(sb.register(fakePort(), reg({ world: 1, slot: "WOPR" })), "world-reserved");
});

test("world-reserved beats slot-taken: a reserved world never leaks its occupancy", () => {
  // The flagship holds world 1 / WOPR (placed with the key). A caller without
  // the key asking for that exact slot must not learn it is taken — the world
  // is simply not theirs to ask about.
  const sb = new Switchboard({ reserveKey: "K" });
  assert.deepEqual(
    (({ world, slot }) => ({ world, slot }))(place(sb, { key: "K", world: 1, slot: "WOPR" })),
    { world: 1, slot: "WOPR" },
  );
  assert.equal(sb.register(fakePort(), reg({ world: 1, slot: "WOPR" })), "world-reserved");
});

test("the reserve key unlocks a reserved world; a wrong key does not", () => {
  const sb = new Switchboard({ reserveKey: "K" });
  assert.equal(place(sb, { key: "K", slot: "WOPR" }).world, 1);
  assert.equal(sb.register(fakePort(), reg({ key: "WRONG", world: 1, slot: "SCHOOL" })), "world-reserved");
  // No key at all: the auto path skips the reserved world silently.
  assert.equal(place(sb, { slot: "SCHOOL" }).world, 2);
});

test("an unset hub key means nothing unlocks world 1, not that any key does", () => {
  const sb = new Switchboard();
  assert.equal(sb.register(fakePort(), reg({ key: "K", world: 1, slot: "WOPR" })), "world-reserved");
  // A key-bearing REGISTER is still placed — just not in the reserved world.
  assert.equal(place(sb, { key: "K", slot: "WOPR" }).world, 2);
});

test("directory marks reserved worlds, and world 1 stays pinned while reserved", () => {
  const sb = new Switchboard();
  assert.deepEqual(sb.directory("http://hub"), [{ n: 1, reserved: true, slots: [] }]);
  place(sb, { slot: "WOPR" });                                    // world 2
  const dir = sb.directory("http://hub");
  assert.deepEqual(dir.map((w) => [w.n, w.reserved]), [[1, true], [2, undefined]]);
  assert.deepEqual(dir[1].slots.map((e) => e.slot), ["WOPR"]);
});

test("reservedWorlds: [] restores the open board", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);
  assert.deepEqual(sb.directory("http://hub")[0].reserved, undefined);
});

test("any world can be reserved, not just world 1", () => {
  const sb = new Switchboard({ reservedWorlds: [2] });
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);
  // World 2 is next by number, but it is reserved: the overflow opens world 3.
  assert.equal(place(sb, { slot: "WOPR" }).world, 3);
  assert.equal(sb.register(fakePort(), reg({ world: 2, slot: "WOPR" })), "world-reserved");
});

test("an empty reserve key is no key at all — it must not unlock anything", () => {
  // A misconfigured hub (TIELINE-side "" plumbed through, an env var expanded
  // to nothing) must fail CLOSED: with reserveKey "" the world stays reserved,
  // and a REGISTER carrying key "" — which the codec accepts, length 0 — is
  // refused like any other unkeyed caller.
  const sb = new Switchboard({ reserveKey: "" });
  assert.equal(sb.register(fakePort(), reg({ key: "", world: 1, slot: "WOPR" })), "world-reserved");
  assert.equal(sb.register(fakePort(), reg({ world: 1, slot: "WOPR" })), "world-reserved");
  // And the auto path still skips the reserved world for a key: "" caller.
  assert.equal(place(sb, { key: "", slot: "WOPR" }).world, 2);
});
