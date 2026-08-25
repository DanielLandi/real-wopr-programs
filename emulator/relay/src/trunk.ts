// TRUNK/1 — exchange-to-exchange trunking (trunk-federation spec). The hub is
// a switchboard: it assigns exchange codes, relays call channels and an
// allowlisted REST subset down each trunk, and never inspects relayed payloads.

/** Where a relayed call came from. A machine caller is a world-local slot; a
 *  person is an opaque seat handle (worlds phase 2 piece B). Today its
 *  PRESENCE is how a bridge tells a machine call from a visitor call — that is
 *  the whole mechanism, not a hint. That stops being true the moment piece B
 *  starts sending `origin: { seat }` on a visitor's OPEN: from then on the
 *  SHAPE discriminates, not the presence. See `Exchange.originated`. */
export type CallOrigin = { world: number; slot: string } | { seat: string };

/** Who a PLACE is addressed to. The seat shape is accepted by the wire now so
 *  piece B is a switchboard change, not a second protocol change. */
export type CallTarget = { world?: number; slot: string } | { seat: string };

/** Closed set. Each reason is distinct because a host operator has to tell
 *  "nobody is in that slot" from "they are full" from "you may not relay". */
export type RefusedReason =
  | "offline" | "busy" | "seat-gone" | "depth" | "oversize" | "self";

const REFUSED_REASONS = new Set<string>(
  ["offline", "busy", "seat-gone", "depth", "oversize", "self"]);

export type TrunkFrame =
  | { t: "REGISTER"; v: 1; name: string; region: string; joshua: "claude" | "period";
      operator?: string; slot?: string; world?: number | "NEW"; key?: string }
  | { t: "ASSIGNED"; exchange: string; world: number; slot: string }
  | { t: "OPEN"; chan: number; query: string; origin?: CallOrigin }
  | { t: "PLACE"; call: number; on?: number; to: CallTarget }
  | { t: "PLACED"; call: number; chan: number }
  | { t: "REFUSED"; call: number; reason: RefusedReason }
  | { t: "FRAME"; chan: number; data: string }
  | { t: "CLOSE"; chan: number; reason?: string }
  | { t: "REQUEST"; rid: number; method: string; path: string; body?: string }
  | { t: "RESPONSE"; rid: number; status: number; body: string }
  | { t: "PING" }
  | { t: "PONG" };

export const TRUNK_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TRUNK_MAX_FRAME_BYTES = 8192;

// The film's wardial cast (docs/period-systems.md in the engine repo) plus
// overflow slots for original systems. Slot names double as the world-local
// numbering plan in phase 2 — fixed here, never renamed.
//
// HOME is deliberately absent. It is David's desk: the seat a caller dials
// FROM, not a service anyone can host. Keeping it off the roster is what makes
// that true on the wire — the REGISTER codec's membership check below refuses
// it, the tieline CLI never offers it, and the directory's roster sort will
// never meet one.
export const NAMED_SLOTS = ["WOPR", "SCHOOL", "PANAM", "PROTOVISION", "PACTEL", "BANK"] as const;
export const WILDCARD_SLOTS = ["OTHER-1", "OTHER-2"] as const;
export const ALL_SLOTS: readonly string[] = [...NAMED_SLOTS, ...WILDCARD_SLOTS];

const FRAME_TYPES = new Set(["REGISTER", "ASSIGNED", "OPEN", "FRAME", "CLOSE",
                             "REQUEST", "RESPONSE", "PING", "PONG",
                             "PLACE", "PLACED", "REFUSED"]);

function checkTarget(to: unknown): void {
  if (!to || typeof to !== "object") throw new Error("bad target");
  const t = to as { world?: unknown; slot?: unknown; seat?: unknown };
  // A target is one shape or the other, never both, and the SEAT KEY is what
  // picks the shape — because that is what the switchboard reads (`"seat" in
  // to`, placeCall). Discriminating here on `typeof t.seat === "string"`
  // instead let `{ seat: 7, slot: "PANAM" }` decode as a healthy slot call and
  // then be refused "seat-gone": two readers disagreeing about what one frame
  // means. Refuse the ambiguity at the wire, and name a bad seat as a bad seat
  // rather than letting it fall through to the slot branch.
  if ("seat" in t && "slot" in t) throw new Error("bad target: seat and slot");
  if ("seat" in t) {
    if (typeof t.seat !== "string") throw new Error("bad seat");
    if (t.seat.length < 1 || t.seat.length > 64) throw new Error("bad seat");
    return;
  }
  if (typeof t.slot !== "string" || !ALL_SLOTS.includes(t.slot)) throw new Error("bad slot");
  if (t.world !== undefined && (!Number.isInteger(t.world) || (t.world as number) < 1)) {
    throw new Error("bad world");
  }
}

function checkOrigin(o: unknown): void {
  if (!o || typeof o !== "object") throw new Error("bad origin");
  const g = o as { world?: unknown; slot?: unknown; seat?: unknown };
  if (typeof g.seat === "string") {
    if (g.seat.length < 1 || g.seat.length > 64) throw new Error("bad origin seat");
    return;
  }
  if (!Number.isInteger(g.world) || (g.world as number) < 1) throw new Error("bad origin world");
  if (typeof g.slot !== "string" || !ALL_SLOTS.includes(g.slot)) throw new Error("bad origin slot");
}

export function decodeTrunkFrame(raw: string): TrunkFrame {
  if (Buffer.byteLength(raw) > TRUNK_MAX_FRAME_BYTES) throw new Error("oversize frame");
  const f = JSON.parse(raw) as TrunkFrame;
  if (!f || typeof f !== "object" || !FRAME_TYPES.has((f as { t: string }).t)) throw new Error("unknown frame");
  // Wire-level field-type checks only: `data`/`body` content stays opaque —
  // the switchboard never inspects relayed payloads, it just requires that
  // they arrive as strings so a raw ws send() cannot blow up downstream.
  if (f.t === "REGISTER") {
    if (f.v !== 1) throw new Error("bad version");
    if (typeof f.name !== "string" || f.name.length < 2 || f.name.length > 24) throw new Error("bad name");
    if (typeof f.region !== "string" || f.region.length < 2 || f.region.length > 24) throw new Error("bad region");
    if (f.joshua !== "claude" && f.joshua !== "period") throw new Error("bad joshua");
    if (f.operator !== undefined && (typeof f.operator !== "string" || f.operator.length > 24)) throw new Error("bad operator");
    if (f.slot !== undefined && (typeof f.slot !== "string" || !ALL_SLOTS.includes(f.slot))) throw new Error("bad slot");
    if (f.world !== undefined && f.world !== "NEW" && (!Number.isInteger(f.world) || f.world < 1)) throw new Error("bad world");
    // The reserve key is opaque to the wire — the hub compares it, nothing
    // parses it — but it is still operator-supplied text on a public socket,
    // so bound it like every other REGISTER field.
    if (f.key !== undefined && (typeof f.key !== "string" || f.key.length > 64)) throw new Error("bad key");
  } else if (f.t === "ASSIGNED") {
    if (typeof f.exchange !== "string") throw new Error("bad exchange");
    if (!Number.isInteger(f.world) || f.world < 1) throw new Error("bad world");
    if (typeof f.slot !== "string") throw new Error("bad slot");
  } else if (f.t === "OPEN") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    if (typeof f.query !== "string") throw new Error("bad query");
    if (f.origin !== undefined) checkOrigin(f.origin);
  } else if (f.t === "PLACE") {
    if (!Number.isInteger(f.call)) throw new Error("bad call");
    if (f.on !== undefined && !Number.isInteger(f.on)) throw new Error("bad on");
    checkTarget(f.to);
  } else if (f.t === "PLACED") {
    if (!Number.isInteger(f.call)) throw new Error("bad call");
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
  } else if (f.t === "REFUSED") {
    if (!Number.isInteger(f.call)) throw new Error("bad call");
    if (typeof f.reason !== "string" || !REFUSED_REASONS.has(f.reason)) {
      throw new Error("bad reason");
    }
  } else if (f.t === "FRAME") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    if (typeof f.data !== "string") throw new Error("bad data");
  } else if (f.t === "CLOSE") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    // The reason is relayed verbatim as a ws close reason (<=123 bytes by
    // spec, ws throws above that) — cap it at the wire.
    if (f.reason !== undefined &&
        (typeof f.reason !== "string" || Buffer.byteLength(f.reason) > 100)) throw new Error("bad reason");
  } else if (f.t === "REQUEST") {
    if (!Number.isInteger(f.rid)) throw new Error("bad rid");
    if (typeof f.method !== "string") throw new Error("bad method");
    if (typeof f.path !== "string") throw new Error("bad path");
    if (f.body !== undefined && typeof f.body !== "string") throw new Error("bad body");
  } else if (f.t === "RESPONSE") {
    if (!Number.isInteger(f.rid)) throw new Error("bad rid");
    // The status is fed straight into res.writeHead, which throws outside the
    // HTTP range — a hostile host must not be able to crash the hub with it.
    if (!Number.isInteger(f.status) || f.status < 100 || f.status > 599) throw new Error("bad status");
    if (typeof f.body !== "string") throw new Error("bad body");
  }
  return f;
}

const REST_ALLOWLIST: Array<[string, RegExp]> = [
  ["POST", /^\/api\/session$/],
  ["GET", /^\/api\/session\/[0-9a-f-]{36}$/],
  ["POST", /^\/api\/room$/],
  ["GET", /^\/api\/room\/[A-Z2-9]{6}$/],
  ["GET", /^\/api\/games$/],
  ["GET", /^\/health$/],
];

export function restAllowed(method: string, path: string): boolean {
  return REST_ALLOWLIST.some(([m, re]) => m === method.toUpperCase() && re.test(path));
}

export function newExchangeCode(): string {
  let code = "";
  while (code.length < 6) {
    const ch = TRUNK_ALPHABET[Math.floor(Math.random() * TRUNK_ALPHABET.length)];
    code += ch;
  }
  return code;
}

export interface DirectoryEntry {
  id: string; name: string; region: string; api: string; link: string;
  joshua: string; operator?: string; online: true;
  world: number; slot: string;
  /** The bridge system id a surface must name to open a session against this
   *  slot (`POST /api/session { system }`). Present only on seeded period
   *  systems — a WOPR/Joshua line has none. Opaque here: which ids exist is
   *  the node host's business, not the hub's. */
  system?: string;
}
/** `reserved` is present (and always literal `true`) only for a world the hub
 *  holds back for a keyed caller — surfaces print it, they never infer it. */
export interface WorldDirectory { n: number; reserved?: true; slots: DirectoryEntry[] }

// TrunkPort is the minimal socket shape the registry needs (ws WebSocket satisfies it);
// tests pass fakes.
export interface TrunkPort { send(data: string): void; close(code?: number, reason?: string): void; }
export interface ChannelPort extends TrunkPort {}

interface Exchange {
  code: string; name: string; region: string; joshua: string; operator?: string;
  port: TrunkPort;
  world: number; slot: string;
  channels: Map<number, ChannelPort>;
  nextChan: number;
  /** Channels on THIS exchange that arrived FROM A MACHINE — a call another
   *  exchange placed to us. A call answering one of these may not place
   *  another: that is the one-hop cap, and it is why a ring cannot form.
   *
   *  The predicate is "from a machine", NOT "arrived carrying an origin", and
   *  the difference is a trap piece B walks straight into: once seats exist,
   *  EVERY inbound OPEN carries an origin — a visitor's is `origin: { seat }`.
   *  Testing for an origin's presence would then mark every visitor channel
   *  originated and refuse the person -> machine -> machine chain the spec
   *  exists to allow. placeCall is the only writer, and must stay so. */
  originated: Set<number>;
  pending: Map<number, { resolve: (r: { status: number; body: string }) => void;
                         reject: (e: string) => void; timer: NodeJS.Timeout }>;
  nextRid: number;
  missedPongs: number;
}

/** One line of the hub's own world-1 manifest. The flagship does not dial its
 *  own switchboard, so its slots are not registrants: they are declared here
 *  and synthesized into the directory at startup. */
export interface LocalSlot {
  slot: string;
  name: string;
  region: string;
  /** Bridge system id, for a slot that is a period system rather than Joshua. */
  system?: string;
  joshua?: "claude" | "period";
  /** Who runs this line, as a REGISTER would carry it. A seeded slot has no
   *  registrant to name itself, so the manifest names it — otherwise the
   *  flagship's own world is the only one in the book with no operator. */
  operator?: string;
}

/** Vet a manifest the way `decodeTrunkFrame` vets a REGISTER: a bad entry is a
 *  deploy error, so it throws at construction rather than degrading into a
 *  directory the operator never wrote. */
function checkLocalWorld(seeds: LocalSlot[]): LocalSlot[] {
  const seen = new Set<string>();
  return seeds.map((s) => {
    // The manifest is parsed JSON, so an element need not be an object: check
    // that before reading a field off it, or `[null]` in TRUNK_LOCAL_WORLD
    // aborts startup with a raw TypeError instead of naming the problem.
    if (!s || typeof s !== "object") throw new Error("local world: bad entry");
    // HOME is off the roster entirely, so the generic check below would already
    // refuse it — but as a bare "bad slot", which reads like a typo. It is not:
    // HOME is the *caller's* end of the call, the seat a visitor dials from,
    // and an operator who tried to seed it made a conceptual mistake worth
    // naming. Wildcards are what the hub hands out to a registrant that did not
    // ask for a slot; a manifest says what it is seeding by name.
    if (s.slot === "HOME") {
      throw new Error("local world: HOME is the caller's own seat, never a hosted slot");
    }
    if (!NAMED_SLOTS.includes(s.slot as (typeof NAMED_SLOTS)[number])) {
      throw new Error(`local world: bad slot ${JSON.stringify(s.slot)}`);
    }
    if (seen.has(s.slot)) throw new Error(`local world: duplicate slot ${s.slot}`);
    seen.add(s.slot);
    // The same 2-24 bounds the wire imposes on a REGISTER: the DIRECTORY
    // screen's 80-column budget is computed against that ceiling. Measured
    // after uppercasing, which is what the directory will actually print.
    // Typed, not coerced: the manifest arrives as parsed JSON, so a number
    // where a name belongs is a mistake to report, not one to stringify.
    if (typeof s.name !== "string") throw new Error(`local world: bad name for ${s.slot}`);
    if (typeof s.region !== "string") throw new Error(`local world: bad region for ${s.slot}`);
    const name = s.name.toUpperCase();
    const region = s.region.toUpperCase();
    if (name.length < 2 || name.length > 24) throw new Error(`local world: bad name for ${s.slot}`);
    if (region.length < 2 || region.length > 24) throw new Error(`local world: bad region for ${s.slot}`);
    if (s.system !== undefined &&
        (typeof s.system !== "string" || s.system.length < 1 || s.system.length > 24)) {
      throw new Error(`local world: bad system for ${s.slot}`);
    }
    if (s.joshua !== undefined && s.joshua !== "claude" && s.joshua !== "period") {
      throw new Error(`local world: bad joshua for ${s.slot}`);
    }
    // The same ceiling decodeTrunkFrame puts on a REGISTER's operator: the
    // directory prints seeded and registered entries in the same column.
    if (s.operator !== undefined && (typeof s.operator !== "string" || s.operator.length > 24)) {
      throw new Error(`local world: bad operator for ${s.slot}`);
    }
    return { ...s, name, region };
  });
}

export class Switchboard {
  private exchanges = new Map<string, Exchange>();
  private maxExchanges: number;
  private maxChannels: number;
  private maxWorlds: number;
  private reservedWorlds: number[];
  private reserveKey: string | undefined;
  private localWorld: LocalSlot[];

  constructor(opts: { maxExchanges?: number; maxChannels?: number; maxWorlds?: number;
                      reservedWorlds?: number[]; reserveKey?: string;
                      localWorld?: LocalSlot[] } = {}) {
    this.maxExchanges = opts.maxExchanges ?? 32;
    this.maxChannels = opts.maxChannels ?? 16;
    this.maxWorlds = opts.maxWorlds ?? 8;
    // World 1 is the flagship's by default. With no usable reserveKey
    // NOTHING unlocks it: a hub that has not been told the key holds the world
    // closed rather than handing it to the first caller who guesses.
    this.reservedWorlds = opts.reservedWorlds ?? [1];
    this.reserveKey = opts.reserveKey;
    // World 1 is never *claimed*: the hub seeds it from this manifest, so the
    // flagship needs no trunk back to itself and its entries dial the public
    // base directly.
    this.localWorld = checkLocalWorld(opts.localWorld ?? []);
  }

  /** Where does a REGISTER land? Worlds are derived, not stored: a world is
   *  the set of live exchanges tagged with its number. World 1 is pinned —
   *  and, unless the caller carries the hub's key, reserved. */
  private place(req: { slot?: string; world?: number | "NEW"; key?: string }):
      { world: number; slot: string } | "no-circuits" | "slot-taken" | "world-reserved" {
    // One comparison decides the whole placement: with the hub's key the
    // reserved worlds behave like any other, without it they do not exist.
    // `!!this.reserveKey`, not `!== undefined`: an empty key is a
    // misconfiguration (an unset variable expanded into the config), and the
    // codec accepts `key: ""` on the wire (length 0), so honoring "" would
    // hand every reserved world to a one-line REGISTER. This is the invariant
    // for BOTH configuration paths — env and opts — not just the env read.
    const unlocked = !!this.reserveKey && req.key === this.reserveKey;
    const reserved = (w: number) => !unlocked && this.reservedWorlds.includes(w);
    const occ = new Map<number, Set<string>>();
    for (const ex of this.exchanges.values()) {
      let s = occ.get(ex.world);
      if (!s) occ.set(ex.world, (s = new Set()));
      s.add(ex.slot);
    }
    // A seeded slot is filled, even though nothing is registered in it: an
    // unlocked keyed REGISTER for CHEYENNE MOUNTAIN's slot is "slot-taken",
    // not a silent second occupant of world 1.
    if (this.localWorld.length > 0) {
      let s = occ.get(1);
      if (!s) occ.set(1, (s = new Set()));
      for (const seed of this.localWorld) s.add(seed.slot);
    }
    const open = (w: number): string | null =>
      req.slot !== undefined
        ? (occ.get(w)?.has(req.slot) ? null : req.slot)
        : WILDCARD_SLOTS.find((s) => !occ.get(w)?.has(s)) ?? null;

    if (typeof req.world === "number") {
      // decodeTrunkFrame already rejects world < 1 on the wire; the floor is
      // repeated here so an in-process caller cannot place an exchange into
      // world 0 or a negative world that the directory would then expose.
      if (req.world < 1 || req.world > this.maxWorlds) return "no-circuits";
      // Before the occupancy check, deliberately: "slot taken" would tell an
      // unkeyed caller who is living in the reserved world. Not their world,
      // not their business.
      if (reserved(req.world)) return "world-reserved";
      const slot = open(req.world);
      return slot === null ? "slot-taken" : { world: req.world, slot };
    }
    // Live worlds first in numeric order (NEW skips them), then the lowest
    // unopened number up to the cap.
    const live = [...new Set([1, ...occ.keys()])].sort((a, b) => a - b);
    if (req.world !== "NEW") {
      for (const w of live) {
        if (reserved(w)) continue;
        const slot = open(w);
        if (slot !== null) return { world: w, slot };
      }
    }
    for (let w = 1; w <= this.maxWorlds; w++) {
      if (live.includes(w) || reserved(w)) continue;
      const slot = open(w);
      if (slot !== null) return { world: w, slot };
    }
    return "no-circuits";
  }

  register(port: TrunkPort, f: Extract<TrunkFrame, { t: "REGISTER" }>):
      { code: string; world: number; slot: string } | "full" | "no-circuits" | "slot-taken" | "world-reserved" {
    if (this.exchanges.size >= this.maxExchanges) return "full";
    const placed = this.place({ slot: f.slot, world: f.world, key: f.key });
    if (typeof placed === "string") return placed;
    let code = newExchangeCode();
    while (this.exchanges.has(code)) code = newExchangeCode();
    this.exchanges.set(code, {
      code, name: f.name.toUpperCase(), region: f.region.toUpperCase(),
      joshua: f.joshua, operator: f.operator, port,
      world: placed.world, slot: placed.slot,
      channels: new Map(), nextChan: 1, originated: new Set(),
      pending: new Map(), nextRid: 1, missedPongs: 0,
    });
    return { code, world: placed.world, slot: placed.slot };
  }

  unregister(code: string): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    this.exchanges.delete(code);
    for (const client of ex.channels.values()) client.close(1001, "trunk dropped");
    // The exchange was live when it accepted these requests: reject them as a
    // mid-flight drop (502 at the relay), not as an unknown code ("offline").
    for (const p of ex.pending.values()) { clearTimeout(p.timer); p.reject("dropped"); }
  }

  openChannel(code: string, client: ChannelPort, query: string): number | "offline" | "busy" | "oversize" {
    const ex = this.exchanges.get(code);
    if (!ex) return "offline";
    if (ex.channels.size >= this.maxChannels) return "busy";
    const chan = ex.nextChan;
    const encoded = JSON.stringify({ t: "OPEN", chan, query });
    // JSON-escaping puts no upper bound on the wrapped query relative to the
    // raw URL: refuse an OPEN the trunk leg could never carry rather than
    // sending a frame the host-side decoder would drop (leaving this end's
    // channel slot half-open forever).
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) return "oversize";
    ex.nextChan += 1;
    ex.channels.set(chan, client);
    ex.port.send(encoded);
    return chan;
  }

  closeChannel(code: string, chan: number): void {
    const ex = this.exchanges.get(code);
    if (!ex || !ex.channels.has(chan)) return;
    ex.channels.delete(chan);
    ex.originated.delete(chan);
    ex.port.send(JSON.stringify({ t: "CLOSE", chan }));
  }

  clientFrame(code: string, chan: number, data: string): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    const client = ex.channels.get(chan);
    if (!client) return;
    const encoded = JSON.stringify({ t: "FRAME", chan, data });
    // A legal <=8192-byte visitor frame can escape-amplify past the trunk cap
    // once wrapped (every `"` and `\` doubles); the host-side decoder would
    // discard the oversize frame silently. Close the call explicitly on both
    // legs instead of corrupting the stream.
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) {
      ex.channels.delete(chan);
      ex.originated.delete(chan);
      client.close(1009, "frame exceeds trunk capacity");
      ex.port.send(JSON.stringify({ t: "CLOSE", chan, reason: "oversize frame" }));
      return;
    }
    ex.port.send(encoded);
  }

  handleHostFrame(code: string, f: TrunkFrame): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    if (f.t === "FRAME") ex.channels.get(f.chan)?.send(f.data);
    else if (f.t === "CLOSE") {
      // Relay the host's stated reason (decode caps it) instead of discarding it.
      ex.channels.get(f.chan)?.close(1000, f.reason ?? "call ended");
      ex.channels.delete(f.chan);
      ex.originated.delete(f.chan);
    }
    else if (f.t === "RESPONSE") {
      const p = ex.pending.get(f.rid);
      if (p) { clearTimeout(p.timer); ex.pending.delete(f.rid); p.resolve({ status: f.status, body: f.body }); }
    } else if (f.t === "PONG") ex.missedPongs = 0;
  }

  request(code: string, method: string, path: string, body: string | undefined,
          timeoutMs = 10_000): Promise<{ status: number; body: string }> {
    const ex = this.exchanges.get(code);
    if (!ex) return Promise.reject("offline");
    const rid = ex.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ex.pending.delete(rid); reject("timeout"); }, timeoutMs);
      ex.pending.set(rid, { resolve, reject, timer });
      ex.port.send(JSON.stringify({ t: "REQUEST", rid, method, path, body }));
    });
  }

  directory(rawPublicBase: string): WorldDirectory[] {
    // Normalized once, for every entry. A relayed entry always appends
    // `/x/<CODE>`, so a stray trailing slash on TRUNK_PUBLIC_BASE was harmless
    // there — but a SEEDED entry's api IS the base, and `https://hub/` would
    // have the terminal POST to `//api/session`.
    const publicBase = rawPublicBase.replace(/\/+$/, "");
    const wsBase = publicBase.replace(/^http/, "ws");
    const byWorld = new Map<number, DirectoryEntry[]>([[1, []]]); // world 1 pinned
    // The flagship's own slots, synthesized rather than registered. No
    // `/x/<CODE>` hop: there is no trunk to hop over, so every seed points at
    // the hub's public base and a period system carries the bridge `system` id
    // that opens a session against it.
    byWorld.set(1, this.localWorld.map((s) => ({
      id: `local-${s.slot.toLowerCase()}`, name: s.name, region: s.region,
      api: publicBase, link: `${wsBase}/link`,
      joshua: s.joshua ?? "period", operator: s.operator, online: true as const,
      world: 1, slot: s.slot,
      // Spread, not an undefined value: an own `system` key with no value is a
      // different document once a surface round-trips it.
      ...(s.system ? { system: s.system } : {}),
    })));
    for (const ex of this.exchanges.values()) {
      let list = byWorld.get(ex.world);
      if (!list) byWorld.set(ex.world, (list = []));
      list.push({
        id: `trunk-${ex.code.toLowerCase()}`, name: ex.name, region: ex.region,
        api: `${publicBase}/x/${ex.code}`, link: `${wsBase}/x/${ex.code}/link`,
        joshua: ex.joshua, operator: ex.operator, online: true as const,
        world: ex.world, slot: ex.slot,
      });
    }
    return [...byWorld.entries()].sort((a, b) => a[0] - b[0]).map(([n, slots]) => ({
      n,
      // Spread, not `reserved: cond || undefined`: an own key with an
      // undefined value is a different object to a deepStrictEqual and a
      // different document once a surface round-trips it.
      ...(this.reservedWorlds.includes(n) ? { reserved: true as const } : {}),
      slots: slots.sort((a, b) => ALL_SLOTS.indexOf(a.slot) - ALL_SLOTS.indexOf(b.slot)),
    }));
  }

  /** A ChannelPort that writes onto ANOTHER exchange's trunk socket. This is
   *  what makes a machine call reuse the visitor relay path unchanged:
   *  handleHostFrame already does `ex.channels.get(chan)?.send(data)`, so if
   *  that port is one of these, the frame lands on the peer as a FRAME.
   *
   *  `self`/`selfChan` name the leg this port is filed under. A port needs
   *  that only to hang ITSELF up: every ordinary close path deletes the local
   *  entry before calling in here, but the oversize guard below discovers the
   *  problem mid-relay and has to end both legs on its own. */
  private peerPort(peer: Exchange, peerChan: number,
                   self: Exchange, selfChan: number): ChannelPort {
    const hangUpPeer = (reason?: string) => {
      if (!peer.channels.has(peerChan)) return;
      peer.channels.delete(peerChan);
      // Cleared WITH the channel, not left behind. When the caller hangs up
      // first this is the only path that touches the callee's leg, so without
      // this line a machine-originated chan number is retained for the life of
      // the exchange. Inert (nextChan never reuses a number, so a stale entry
      // can never wrongly match) but unbounded, on a hub that runs for weeks.
      peer.originated.delete(peerChan);
      peer.port.send(JSON.stringify({ t: "CLOSE", chan: peerChan, reason }));
    };
    return {
      send: (data: string) => {
        const encoded = JSON.stringify({ t: "FRAME", chan: peerChan, data });
        // The re-check clientFrame already does on the visitor leg, guarding a
        // worse failure. An inbound host FRAME is capped at 8192 by decode, but
        // relaying it renumbers `chan` for the peer, and the extra digits can
        // push the re-wrapped frame past the cap. The peer's decoder would then
        // throw and its server closes the socket 4400 — dropping the WHOLE
        // TRUNK and every call on it, not this one call. So hang up this one
        // call, explicitly, on both legs.
        if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) {
          if (self.channels.delete(selfChan)) {
            self.originated.delete(selfChan);
            self.port.send(JSON.stringify(
              { t: "CLOSE", chan: selfChan, reason: "oversize frame" }));
          }
          hangUpPeer("oversize frame");
          return;
        }
        peer.port.send(encoded);
      },
      close: (_code?: number, reason?: string) => hangUpPeer(reason),
    };
  }

  /** Place a call from one exchange to a world-local slot. `on` names the
   *  channel this call answers, if any — the depth cap uses it to refuse a
   *  relay. Returns the caller's own channel number, or the reason it was
   *  refused. */
  placeCall(fromCode: string, to: CallTarget, on?: number): { chan: number } | RefusedReason {
    const from = this.exchanges.get(fromCode);
    if (!from) return "offline";
    // Honesty about the boundary: `on` is supplied by the host, and the hub
    // cannot see causality. An honest host sets it and cannot relay; a
    // dishonest one could omit it. This is loop prevention for a federation of
    // cooperating hosts, not a defence against a hostile one — the channel cap
    // (maxChannels) is what bounds a bad actor's blast radius.
    // The one-hop cap. `on` names the channel this call answers; if that
    // channel arrived with an origin, the caller is relaying, and relaying is
    // what makes loops possible.
    if (on !== undefined && from.originated.has(on)) return "depth";
    // Seat targets are piece B. The wire accepts them already so piece B does
    // not have to change the protocol a second time; until it lands there is
    // no seat registry, so no handle can resolve.
    if ("seat" in to) return "seat-gone";

    const world = to.world ?? from.world;
    // REGISTERED exchanges only. World 1's SEEDED slots (the `localWorld`
    // manifest) have no trunk port to send an OPEN down, so a PLACE to the
    // flagship's own WOPR answers "offline" while `GET /trunk/directory`
    // lists that same slot online — the directory synthesizes those entries,
    // this cannot. Piece D meets it head-on rather than at the margins: the
    // film's beat is the FLAGSHIP's Joshua placing the call. See issue #67.
    let target: Exchange | undefined;
    for (const ex of this.exchanges.values()) {
      if (ex.world === world && ex.slot === to.slot) { target = ex; break; }
    }
    if (!target) return "offline";
    if (target.code === from.code) return "self";
    if (target.channels.size >= this.maxChannels) return "busy";
    if (from.channels.size >= this.maxChannels) return "busy";

    const calleeChan = target.nextChan;
    const callerChan = from.nextChan;
    const encoded = JSON.stringify({
      // Nothing resolves an empty query yet: the callee's tieline dials
      // `${localComms}/link?` and server.ts refuses it outright for want of
      // `surface` and `session`, closing the local socket 4400 before a byte
      // moves. What session a machine call mints on the callee — whether it
      // mints one at all — is the piece-that-converses question (piece D), so
      // it is left open here rather than guessed into API D would have to
      // undo. See issue #67.
      t: "OPEN", chan: calleeChan, query: "",
      origin: { world: from.world, slot: from.slot },
    });
    // Same guard openChannel uses: never send a frame the peer's decoder
    // would drop, which would leave this end's channel slot half-open.
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) return "oversize";

    target.nextChan += 1;
    from.nextChan += 1;
    target.channels.set(calleeChan, this.peerPort(from, callerChan, target, calleeChan));
    target.originated.add(calleeChan);
    from.channels.set(callerChan, this.peerPort(target, calleeChan, from, callerChan));
    target.port.send(encoded);
    return { chan: callerChan };
  }

  sweepDead(): string[] {
    const dropped: string[] = [];
    for (const ex of this.exchanges.values()) {
      ex.missedPongs += 1;
      if (ex.missedPongs >= 2) dropped.push(ex.code);
      else ex.port.send(JSON.stringify({ t: "PING" }));
    }
    for (const code of dropped) this.unregister(code);
    return dropped;
  }
}
