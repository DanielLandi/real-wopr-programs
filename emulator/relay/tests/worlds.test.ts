// World/slot placement rules (worlds-directory spec, phase 1). Pure
// Switchboard-level tests with fake ports; the wire is Task 3's suite.
//
// World 1 is RESERVED by default (it is the flagship's). The pre-reservation
// tests below are about placement arithmetic, not about reservation, so they
// construct `new Switchboard({ reservedWorlds: [] })` to keep their original
// semantics; the reservation rules get their own cases at the bottom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Switchboard, type LocalSlot, type TrunkFrame } from "../src/trunk.ts";

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
  place(sb, { world: "NEW", slot: "PACTEL" });
  const dir = sb.directory("http://hub");
  assert.deepEqual(dir.map((w) => w.n), [1, 2]);
  assert.deepEqual(dir[0].slots.map((e) => e.slot), ["WOPR", "SCHOOL"]);
  assert.deepEqual(dir[1].slots.map((e) => e.slot), ["PACTEL"]);
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

// ---- world 1 self-seeds -----------------------------------------------------
// The flagship never dials its own hub. World 1 is SYNTHESIZED at startup from
// a local manifest: every entry points straight at the hub's public base (no
// /x/<CODE> trunk hop, because there is no trunk), and a period system carries
// the bridge `system` id the terminal needs to open a system session.

const SEEDS: LocalSlot[] = [
  { slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR" },
  { slot: "SCHOOL", name: "SUNNYVALE SCHOOL DIST", region: "SUNNYVALE CA", system: "school" },
];

test("world 1 seeds from the local manifest: direct-dial entries, system tag where set", () => {
  const sb = new Switchboard({ localWorld: SEEDS });
  const dir = sb.directory("http://hub");
  assert.deepEqual(dir.map((w) => w.n), [1]);
  // Still the flagship's world: seeding it does not open it to registrants.
  assert.equal(dir[0].reserved, true);
  assert.deepEqual(dir[0].slots, [
    {
      id: "local-wopr", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR",
      api: "http://hub", link: "ws://hub/link", joshua: "period",
      operator: undefined, online: true, world: 1, slot: "WOPR",
    },
    {
      id: "local-school", name: "SUNNYVALE SCHOOL DIST", region: "SUNNYVALE CA",
      api: "http://hub", link: "ws://hub/link", joshua: "period",
      operator: undefined, online: true, world: 1, slot: "SCHOOL", system: "school",
    },
  ]);
  // `system` is present only where the manifest set one — an absent key, not
  // an undefined value, so a surface that round-trips the JSON sees the same
  // document the hub built.
  assert.equal("system" in dir[0].slots[0], false);
});

test("a seed carries its operator into the directory, bounded like a REGISTER's", () => {
  // A seeded slot has no registrant to name itself. Without this the flagship's
  // own world is the only one in the book whose lines have no operator.
  const sb = new Switchboard({
    localWorld: [{ ...SEEDS[0], operator: "DanielLandi" }],
  });
  assert.equal(sb.directory("http://hub")[0].slots[0].operator, "DanielLandi");
  // Same 24-char ceiling decodeTrunkFrame puts on a REGISTER's operator.
  assert.throws(
    () => new Switchboard({ localWorld: [{ ...SEEDS[0], operator: "X".repeat(25) }] }),
    /bad operator for WOPR/,
  );
  assert.throws(
    () => new Switchboard({ localWorld: [{ ...SEEDS[0], operator: 7 } as unknown as LocalSlot] }),
    /bad operator for WOPR/,
  );
});

test("a seed's joshua defaults to period and can be named per slot", () => {
  const sb = new Switchboard({
    localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR", joshua: "claude" }],
  });
  assert.equal(sb.directory("http://hub")[0].slots[0].joshua, "claude");
});

test("seeds and live keyed entries merge into one roster-ordered world 1", () => {
  const sb = new Switchboard({ reserveKey: "K", localWorld: SEEDS });
  place(sb, { key: "K", world: 1, slot: "PANAM" });
  const slots = sb.directory("http://hub")[0].slots;
  assert.deepEqual(slots.map((e) => e.slot), ["WOPR", "SCHOOL", "PANAM"]);
  assert.equal(slots[2].api.startsWith("http://hub/x/"), true, "a real trunk entry still relays");
});

test("a seeded slot is occupied: even the hub's own key cannot claim it", () => {
  const sb = new Switchboard({ reserveKey: "K", localWorld: SEEDS });
  // Unlocked (right key), so this is not a reservation refusal — the slot is
  // simply already filled by the seed.
  assert.equal(sb.register(fakePort(), reg({ key: "K", world: 1, slot: "WOPR" })), "slot-taken");
  // A free named slot in the same world is still claimable with the key.
  assert.equal(place(sb, { key: "K", world: 1, slot: "PANAM" }).slot, "PANAM");
});

test("seeds are not exchanges: sweepDead never reaps them", () => {
  const sb = new Switchboard({ localWorld: SEEDS });
  sb.sweepDead();
  sb.sweepDead();
  assert.deepEqual(sb.directory("http://hub")[0].slots.map((e) => e.id),
                   ["local-wopr", "local-school"]);
});

test("seeding world 1 does not disturb auto placement: a plain REGISTER lands world 2", () => {
  const sb = new Switchboard({ localWorld: SEEDS });
  const first = place(sb);
  assert.deepEqual([first.world, first.slot], [2, "OTHER-1"]);
  assert.equal(place(sb, { slot: "WOPR" }).world, 2);
});

test("a malformed manifest is a deploy error: the Switchboard refuses to construct", () => {
  const bad = (localWorld: LocalSlot[]) => () => new Switchboard({ localWorld });
  // The manifest arrives as parsed JSON, so an element need not be an object at
  // all. `[null]` is a bad manifest to report, not a raw TypeError from reading
  // `.slot` of null — the operator has to be able to read what went wrong.
  assert.throws(bad([null as unknown as LocalSlot]), /bad entry/);
  assert.throws(bad(["WOPR" as unknown as LocalSlot]), /bad entry/);
  // HOME is David's desk: the seat a caller dials FROM. It is off the roster
  // entirely now, so it is unregistrable on the wire AND unseedable here — and
  // the manifest error still says which of the two mistakes was made, rather
  // than degrading into the bare "bad slot" every other off-roster name gets.
  assert.throws(bad([{ slot: "HOME", name: "DAVID LIGHTMAN", region: "SEATTLE US" }]),
                /HOME is the caller's own seat/);
  // Wildcards are for registrants who did not ask for a slot; a manifest names
  // what it is seeding.
  assert.throws(bad([{ slot: "OTHER-1", name: "SPARE", region: "SEATTLE US" }]), /slot/);
  assert.throws(bad([{ slot: "NOPE", name: "SPARE", region: "SEATTLE US" }]), /slot/);
  // One slot, one occupant — a duplicate would silently shadow itself.
  assert.throws(bad([SEEDS[0], { ...SEEDS[0], name: "SECOND MOUNTAIN" }]), /duplicate/);
  // Same 2-24 bounds the REGISTER wire imposes: the DIRECTORY screen's column
  // budget is computed against that ceiling (console.ts directoryText).
  assert.throws(bad([{ slot: "WOPR", name: "W", region: "SAO PAULO BR" }]), /name/);
  assert.throws(bad([{ slot: "WOPR", name: "X".repeat(25), region: "SAO PAULO BR" }]), /name/);
  assert.throws(bad([{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "B" }]), /region/);
  // Parsed JSON, not typed source: a number where a name belongs is reported,
  // not coerced into the directory as "42".
  assert.throws(bad([{ slot: "WOPR", name: 42, region: "SAO PAULO BR" } as unknown as LocalSlot]), /name/);
  assert.throws(bad([{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR", system: 7 } as unknown as LocalSlot]), /system/);
  assert.throws(bad([{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR", joshua: "gpt" } as unknown as LocalSlot]), /joshua/);
});

test("a trailing slash on the public base does not double up in the URLs", () => {
  // `TRUNK_PUBLIC_BASE=https://hub.example/` is an easy thing to write, and a
  // seeded entry's api IS the base — so an unnormalized slash would have the
  // terminal POST to `//api/session`. Relayed entries share the normalized
  // base, so their /x/<CODE> URLs are unchanged.
  const sb = new Switchboard({ reserveKey: "K", localWorld: [SEEDS[0]] });
  const live = place(sb, { key: "K", world: 1, slot: "SCHOOL" });
  const slots = sb.directory("https://hub.example///")[0].slots;
  assert.deepEqual([slots[0].api, slots[0].link], ["https://hub.example", "wss://hub.example/link"]);
  assert.deepEqual([slots[1].api, slots[1].link],
                   [`https://hub.example/x/${live.code}`, `wss://hub.example/x/${live.code}/link`]);
});

test("a seed's name and region are uppercased, like a REGISTER's", () => {
  const sb = new Switchboard({
    localWorld: [{ slot: "WOPR", name: "Cheyenne Mountain", region: "Sao Paulo BR" }],
  });
  const e = sb.directory("http://hub")[0].slots[0];
  assert.deepEqual([e.name, e.region], ["CHEYENNE MOUNTAIN", "SAO PAULO BR"]);
});
