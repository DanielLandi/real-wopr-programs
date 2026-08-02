// World/slot placement rules (worlds-directory spec, phase 1). Pure
// Switchboard-level tests with fake ports; the wire is Task 3's suite.
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
  const sb = new Switchboard();
  assert.deepEqual([place(sb).slot, place(sb).slot], ["OTHER-1", "OTHER-2"]);
  const third = place(sb);
  assert.equal(third.world, 2);
  assert.equal(third.slot, "OTHER-1");
});

test("same named slot lands in successive worlds", () => {
  const sb = new Switchboard();
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);
  assert.equal(place(sb, { slot: "WOPR" }).world, 2);
  assert.equal(place(sb, { slot: "SCHOOL" }).world, 1);
});

test("world NEW skips live worlds; explicit world joins or refuses", () => {
  const sb = new Switchboard();
  place(sb, { slot: "WOPR" });                                   // world 1
  assert.equal(place(sb, { world: "NEW", slot: "WOPR" }).world, 2);
  assert.equal(place(sb, { world: 2, slot: "SCHOOL" }).world, 2);
  assert.equal(sb.register(fakePort(), reg({ world: 2, slot: "SCHOOL" })), "slot-taken");
  assert.equal(sb.register(fakePort(), reg({ world: 99, slot: "SCHOOL" })), "no-circuits");
});

test("world cap refuses with no-circuits", () => {
  const sb = new Switchboard({ maxWorlds: 2 });
  place(sb, { slot: "WOPR" }); place(sb, { slot: "WOPR" });
  assert.equal(sb.register(fakePort(), reg({ slot: "WOPR" })), "no-circuits");
  assert.equal(sb.register(fakePort(), reg({ world: "NEW" })), "no-circuits");
});

test("disconnect frees the slot and evaporates the world; world 1 is pinned", () => {
  const sb = new Switchboard();
  const a = place(sb, { slot: "WOPR" });
  const b = place(sb, { slot: "WOPR" });                          // world 2
  sb.unregister(b.code);
  assert.deepEqual(sb.directory("http://hub").map((w) => w.n), [1]);
  sb.unregister(a.code);
  assert.deepEqual(sb.directory("http://hub"), [{ n: 1, slots: [] }]);
  assert.equal(place(sb, { slot: "WOPR" }).world, 1);             // reclaimable
});

test("directory groups by world and orders slots by roster", () => {
  const sb = new Switchboard();
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
