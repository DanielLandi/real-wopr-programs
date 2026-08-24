# Worlds Phase 2, Piece A — Machine-Originated Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered exchange place a call to another exchange's world-local slot over the trunk, with the callee learning who called and a hub-enforced one-hop depth cap.

**Architecture:** Three new TRUNK/1 frames (`PLACE`, `PLACED`, `REFUSED`) and one optional field on the existing `OPEN`. The hub bridges the two exchanges by giving each a `ChannelPort` adapter that writes a `FRAME` onto the peer's trunk socket — so the existing relay path in `handleHostFrame` carries machine calls with no change.

**Tech Stack:** TypeScript on Node ≥ 23.6 (native type-stripping, `.ts` run directly), `ws`, `node:test`.

**Spec:** `../real-wopr/docs/superpowers/specs/2026-08-24-worlds-phase-2-design.md` (§1 Piece A). Read it — the plan argues from it.

## Global Constraints

- **This is piece A of four.** Implement ONLY slot-to-slot calls. `PLACE { to: { seat } }` belongs to piece B: the codec must accept the shape (so B is a switchboard change, not a wire change), but the switchboard refuses it with `seat-gone` until B lands.
- **`OPEN` stays strictly hub→host.** Never send `OPEN` upward, never accept it from a host.
- **`origin` has two shapes:** `{ world, slot }` (a machine called) or `{ seat }` (a person called — piece B). It is optional on the wire.
- **`REFUSED` reasons are a closed set:** `offline`, `busy`, `seat-gone`, `depth`, `oversize`, `self`. Each is distinct because an operator must tell them apart.
- **Depth cap:** a `PLACE` whose `on` names a channel that arrived *with* an `origin` is refused `depth`.
- **Frame cap:** every frame the hub emits must stay within `TRUNK_MAX_FRAME_BYTES` (8192). The existing `openChannel` refuses `oversize` rather than sending a frame the host's decoder would drop; match that.
- **The hub never inspects payloads.** `data` stays opaque; only its type is checked.
- **Determinism in tests:** no wall clock, no unseeded randomness. Tests use `fakePort()`, not real sockets, except the e2e task.
- **Node ≥ 23.6.** Run tests with `npm test` in `emulator/relay`; run one file with `node --test --test-force-exit "tests/<file>"`.

## File Structure

| File | Responsibility |
| --- | --- |
| `emulator/relay/src/trunk.ts` | the TRUNK/1 codec and the `Switchboard`; all of piece A's logic |
| `emulator/relay/src/server.ts` | the `/trunk` leg — routes a decoded `PLACE` into the switchboard |
| `emulator/relay/src/tieline.ts` | the host side — an API to place a call and to see `origin` |
| `emulator/relay/tests/trunk.test.ts` | codec + switchboard unit tests |
| `emulator/relay/tests/trunk-e2e.test.ts` | two real tielines, one calling the other |

No new files. Piece A is an extension of an existing protocol module, and splitting the switchboard would make the diff harder to review, not easier.

---

### Task 1: The codec accepts PLACE, PLACED and REFUSED

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (the `TrunkFrame` union, `FRAME_TYPES`, `decodeTrunkFrame`)
- Test: `emulator/relay/tests/trunk.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the frame types every later task sends and receives —
  `{ t: "PLACE"; call: number; on?: number; to: { world?: number; slot: string } | { seat: string } }`,
  `{ t: "PLACED"; call: number; chan: number }`,
  `{ t: "REFUSED"; call: number; reason: RefusedReason }`,
  and `origin?: { world: number; slot: string } | { seat: string }` on `OPEN`.
  Also `export type RefusedReason = "offline" | "busy" | "seat-gone" | "depth" | "oversize" | "self"`.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/trunk.test.ts`:

```typescript
test("codec: PLACE round-trips both target shapes", () => {
  const slotCall = decodeTrunkFrame(JSON.stringify(
    { t: "PLACE", call: 1, to: { world: 1, slot: "PANAM" } }));
  assert.equal(slotCall.t, "PLACE");
  // The seat shape is piece B's target, but the WIRE must accept it now so
  // piece B is a switchboard change rather than a second protocol change.
  const seatCall = decodeTrunkFrame(JSON.stringify(
    { t: "PLACE", call: 2, to: { seat: "abc" } }));
  assert.equal(seatCall.t, "PLACE");
});

test("codec: PLACE rejects a malformed target", () => {
  const bad = [
    { t: "PLACE", call: 1, to: { slot: "NOPE" } },            // off the roster
    { t: "PLACE", call: 1, to: { world: 0, slot: "PANAM" } },  // worlds start at 1
    { t: "PLACE", call: 1, to: {} },                           // neither shape
    { t: "PLACE", call: 1 },                                   // no target
    { t: "PLACE", to: { slot: "PANAM" } },                     // no call id
    { t: "PLACE", call: "x", to: { slot: "PANAM" } },          // call not a number
    { t: "PLACE", call: 1, on: "x", to: { slot: "PANAM" } },   // on not a number
    { t: "PLACE", call: 1, to: { seat: 7 } },                  // seat not a string
  ];
  for (const f of bad) {
    assert.throws(() => decodeTrunkFrame(JSON.stringify(f)), /PLACE|call|target|slot|world|seat|on/,
      `accepted a malformed PLACE: ${JSON.stringify(f)}`);
  }
});

test("codec: PLACED and REFUSED round-trip, and REFUSED's reason is closed", () => {
  const placed = decodeTrunkFrame(JSON.stringify({ t: "PLACED", call: 3, chan: 9 }));
  assert.equal(placed.t, "PLACED");
  for (const reason of ["offline", "busy", "seat-gone", "depth", "oversize", "self"]) {
    const r = decodeTrunkFrame(JSON.stringify({ t: "REFUSED", call: 3, reason }));
    assert.equal(r.t, "REFUSED");
  }
  assert.throws(() => decodeTrunkFrame(JSON.stringify(
    { t: "REFUSED", call: 3, reason: "because" })), /reason/);
});

test("codec: OPEN carries an optional origin, in either shape", () => {
  const bare = decodeTrunkFrame(JSON.stringify({ t: "OPEN", chan: 1, query: "" }));
  assert.equal(bare.t, "OPEN");
  const fromMachine = decodeTrunkFrame(JSON.stringify(
    { t: "OPEN", chan: 1, query: "", origin: { world: 1, slot: "WOPR" } }));
  assert.equal(fromMachine.t, "OPEN");
  const fromSeat = decodeTrunkFrame(JSON.stringify(
    { t: "OPEN", chan: 1, query: "", origin: { seat: "abc" } }));
  assert.equal(fromSeat.t, "OPEN");
  assert.throws(() => decodeTrunkFrame(JSON.stringify(
    { t: "OPEN", chan: 1, query: "", origin: { slot: "NOPE" } })), /origin|slot/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: the four new tests FAIL — `decodeTrunkFrame` throws "unknown frame" for `PLACE`, because `FRAME_TYPES` does not contain it.

- [ ] **Step 3: Extend the type union and the type set**

In `src/trunk.ts`, add to the `TrunkFrame` union after the `OPEN` member, and extend `OPEN` itself:

```typescript
  | { t: "OPEN"; chan: number; query: string; origin?: CallOrigin }
  | { t: "PLACE"; call: number; on?: number; to: CallTarget }
  | { t: "PLACED"; call: number; chan: number }
  | { t: "REFUSED"; call: number; reason: RefusedReason }
```

and above the union:

```typescript
/** Where a relayed call came from. A machine caller is a world-local slot; a
 *  person is an opaque seat handle (worlds phase 2 piece B). Its PRESENCE is
 *  how a bridge tells a machine call from a visitor call — that is the whole
 *  mechanism, not a hint. */
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
```

Add the three names to `FRAME_TYPES`:

```typescript
const FRAME_TYPES = new Set(["REGISTER", "ASSIGNED", "OPEN", "FRAME", "CLOSE",
                             "REQUEST", "RESPONSE", "PING", "PONG",
                             "PLACE", "PLACED", "REFUSED"]);
```

- [ ] **Step 4: Add the validation**

Still in `decodeTrunkFrame`, add these branches alongside the existing ones. Put the `origin` check inside the existing `f.t === "OPEN"` branch:

```typescript
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
  }
```

and add these two helpers above `decodeTrunkFrame`:

```typescript
function checkTarget(to: unknown): void {
  if (!to || typeof to !== "object") throw new Error("bad target");
  const t = to as { world?: unknown; slot?: unknown; seat?: unknown };
  if (typeof t.seat === "string") {
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
```

In the existing `OPEN` branch, after the `query` check:

```typescript
    if (f.origin !== undefined) checkOrigin(f.origin);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: all pass, including every pre-existing test in the file.

Then: `cd emulator/relay && npm run typecheck` — must be clean. `CallOrigin` and `CallTarget` are unions, so TypeScript will require narrowing wherever you read `.slot` off one; that is intentional and Task 2 handles it.

- [ ] **Step 6: Commit**

```bash
git add emulator/relay/src/trunk.ts emulator/relay/tests/trunk.test.ts
git commit -m "feat(trunk): PLACE, PLACED and REFUSED join TRUNK/1"
```

---

### Task 2: The switchboard bridges two exchanges

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (the `Switchboard` class)
- Test: `emulator/relay/tests/trunk.test.ts`

**Interfaces:**
- Consumes: Task 1's `CallTarget`, `CallOrigin`, `RefusedReason`.
- Produces: `placeCall(fromCode: string, to: CallTarget): { chan: number } | RefusedReason` on `Switchboard`. Task 3 adds the depth check to it; Task 4 calls it from the server; Task 5's host uses it through the wire.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/trunk.test.ts`. The existing `fakePort()` helper at the top of the file gives you `sent: string[]`:

```typescript
test("placeCall: bridges two exchanges and tells the callee who called", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = fakePort(), b = fakePort();
  const placedA = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                                   joshua: "period", world: 1, slot: "WOPR" });
  const placedB = sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                                   joshua: "period", world: 1, slot: "PANAM" });
  assert.notEqual(typeof placedA, "string");
  assert.notEqual(typeof placedB, "string");
  const codeA = (placedA as { code: string }).code;

  const r = sb.placeCall(codeA, { world: 1, slot: "PANAM" });
  assert.equal(typeof r, "object", `expected a channel, got ${JSON.stringify(r)}`);
  const { chan } = r as { chan: number };

  // The callee sees an OPEN carrying the CALLER's world and slot.
  const openB = b.sent.map((s) => JSON.parse(s)).find((f) => f.t === "OPEN");
  assert.ok(openB, "the callee never received an OPEN");
  assert.deepEqual(openB.origin, { world: 1, slot: "WOPR" });

  // Frames cross both ways, through the ordinary relay path.
  sb.handleHostFrame(codeA, { t: "FRAME", chan, data: "HELLO" });
  const toB = b.sent.map((s) => JSON.parse(s)).filter((f) => f.t === "FRAME");
  assert.deepEqual(toB.map((f) => f.data), ["HELLO"]);

  const codeB = (placedB as { code: string }).code;
  sb.handleHostFrame(codeB, { t: "FRAME", chan: openB.chan, data: "HI BACK" });
  const toA = a.sent.map((s) => JSON.parse(s)).filter((f) => f.t === "FRAME");
  assert.deepEqual(toA.map((f) => f.data), ["HI BACK"]);
});

test("placeCall: a closed leg closes its peer", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = fakePort(), b = fakePort();
  const pa = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                              joshua: "period", world: 1, slot: "WOPR" });
  sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                   joshua: "period", world: 1, slot: "PANAM" });
  const codeA = (pa as { code: string }).code;
  const { chan } = sb.placeCall(codeA, { world: 1, slot: "PANAM" }) as { chan: number };
  const openB = b.sent.map((s) => JSON.parse(s)).find((f) => f.t === "OPEN");

  sb.handleHostFrame(codeA, { t: "CLOSE", chan, reason: "caller hung up" });
  const closeB = b.sent.map((s) => JSON.parse(s)).filter((f) => f.t === "CLOSE");
  assert.equal(closeB.length, 1, "the callee's leg was left open");
  assert.equal(closeB[0].chan, openB.chan);
});

test("placeCall: every refusal reason is reachable and distinct", () => {
  const sb = new Switchboard({ reservedWorlds: [], maxChannels: 1 });
  const a = fakePort(), b = fakePort();
  const pa = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                              joshua: "period", world: 1, slot: "WOPR" });
  const codeA = (pa as { code: string }).code;

  assert.equal(sb.placeCall(codeA, { world: 1, slot: "PANAM" }), "offline",
    "no exchange in that slot");
  assert.equal(sb.placeCall(codeA, { world: 1, slot: "WOPR" }), "self",
    "an exchange must not call itself");
  assert.equal(sb.placeCall(codeA, { seat: "nobody" }), "seat-gone",
    "seats arrive in piece B; until then the handle cannot resolve");

  sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                   joshua: "period", world: 1, slot: "PANAM" });
  assert.equal(typeof sb.placeCall(codeA, { world: 1, slot: "PANAM" }), "object");
  assert.equal(sb.placeCall(codeA, { world: 1, slot: "PANAM" }), "busy",
    "maxChannels is 1, so the second call finds the callee full");
});

test("placeCall: an omitted world means the caller's own world", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = fakePort(), b = fakePort();
  const pa = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                              joshua: "period", world: 2, slot: "WOPR" });
  sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                   joshua: "period", world: 2, slot: "PANAM" });
  const codeA = (pa as { code: string }).code;
  assert.equal(typeof sb.placeCall(codeA, { slot: "PANAM" }), "object",
    "a slot with no world should resolve inside the caller's world");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: the four new tests FAIL with `sb.placeCall is not a function`.

- [ ] **Step 3: Implement the peer adapter and `placeCall`**

Add to `src/trunk.ts`, inside the `Switchboard` class:

```typescript
  /** A ChannelPort that writes onto ANOTHER exchange's trunk socket. This is
   *  what makes a machine call reuse the visitor relay path unchanged:
   *  handleHostFrame already does `ex.channels.get(chan)?.send(data)`, so if
   *  that port is one of these, the frame lands on the peer as a FRAME. */
  private peerPort(peer: Exchange, peerChan: number): ChannelPort {
    return {
      send: (data: string) => {
        peer.port.send(JSON.stringify({ t: "FRAME", chan: peerChan, data }));
      },
      close: (_code?: number, reason?: string) => {
        if (!peer.channels.has(peerChan)) return;
        peer.channels.delete(peerChan);
        peer.port.send(JSON.stringify({ t: "CLOSE", chan: peerChan, reason }));
      },
    };
  }

  /** Place a call from one exchange to a world-local slot. Returns the
   *  caller's own channel number, or the reason it was refused. */
  placeCall(fromCode: string, to: CallTarget): { chan: number } | RefusedReason {
    const from = this.exchanges.get(fromCode);
    if (!from) return "offline";
    // Seat targets are piece B. The wire accepts them already so piece B does
    // not have to change the protocol a second time; until it lands there is
    // no seat registry, so no handle can resolve.
    if ("seat" in to) return "seat-gone";

    const world = to.world ?? from.world;
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
      t: "OPEN", chan: calleeChan, query: "",
      origin: { world: from.world, slot: from.slot },
    });
    // Same guard openChannel uses: never send a frame the peer's decoder
    // would drop, which would leave this end's channel slot half-open.
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) return "oversize";

    target.nextChan += 1;
    from.nextChan += 1;
    target.channels.set(calleeChan, this.peerPort(from, callerChan));
    from.channels.set(callerChan, this.peerPort(target, calleeChan));
    target.port.send(encoded);
    return { chan: callerChan };
  }
```

Note `handleHostFrame`'s `CLOSE` branch already deletes the local channel and calls `.close(...)` on the port — which, for a bridged call, is `peerPort.close`, which deletes and notifies the far side. No change to `handleHostFrame` is needed, and the `peer.channels.has` guard is what stops the two sides closing each other forever.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"` — all pass.
Then: `cd emulator/relay && npm test` — the whole relay suite must still pass. `unregister` closes every channel on a dropped exchange; confirm a bridged peer does not throw when its partner vanishes.

- [ ] **Step 5: Commit**

```bash
git add emulator/relay/src/trunk.ts emulator/relay/tests/trunk.test.ts
git commit -m "feat(trunk): the switchboard bridges a machine-placed call"
```

---

### Task 3: The depth cap

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (`Exchange`, `placeCall`)
- Test: `emulator/relay/tests/trunk.test.ts`

**Interfaces:**
- Consumes: Task 2's `placeCall`.
- Produces: `placeCall(fromCode, to, on?: number)` — the third parameter is the channel this call answers. Task 4 passes `f.on` straight through.

- [ ] **Step 1: Write the failing test**

```typescript
test("depth: a call that arrived with an origin may not place another", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = fakePort(), b = fakePort(), c = fakePort();
  const pa = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                              joshua: "period", world: 1, slot: "WOPR" });
  const pb = sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                              joshua: "period", world: 1, slot: "PANAM" });
  sb.register(c, { t: "REGISTER", v: 1, name: "C EXCH", region: "SEATTLE US",
                   joshua: "period", world: 1, slot: "PACTEL" });
  const codeA = (pa as { code: string }).code, codeB = (pb as { code: string }).code;

  sb.placeCall(codeA, { world: 1, slot: "PANAM" });
  const openB = b.sent.map((s) => JSON.parse(s)).find((f) => f.t === "OPEN");

  // B answering A may not relay onward: one hop, so a ring cannot form.
  assert.equal(sb.placeCall(codeB, { world: 1, slot: "PACTEL" }, openB.chan), "depth");

  // But B placing a call of its OWN — not on behalf of that channel — is fine.
  assert.equal(typeof sb.placeCall(codeB, { world: 1, slot: "PACTEL" }), "object");
});

test("depth: a visitor-opened channel is not originated, so its callee may place", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = fakePort(), b = fakePort();
  const pa = sb.register(a, { t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                              joshua: "period", world: 1, slot: "WOPR" });
  sb.register(b, { t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                   joshua: "period", world: 1, slot: "PANAM" });
  const codeA = (pa as { code: string }).code;
  const visitor = fakePort();
  const chan = sb.openChannel(codeA, visitor, "");
  assert.equal(typeof chan, "number", "the visitor channel did not open");
  // A person called A. A answering a person may call onward — that is the
  // whole point: WOPR calls PANAM because a visitor asked it to.
  assert.equal(typeof sb.placeCall(codeA, { world: 1, slot: "PANAM" }, chan as number), "object");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: the first FAILS — `placeCall` ignores its third argument and returns a channel where `"depth"` is required.

- [ ] **Step 3: Track originated channels and check them**

Add to the `Exchange` interface, after `nextChan`:

```typescript
  /** Channels on THIS exchange that arrived carrying an origin — i.e. a
   *  machine called us. A call answering one of these may not place another:
   *  that is the one-hop cap, and it is why a ring cannot form. */
  originated: Set<number>;
```

Initialise it where the exchange record is built (alongside `channels: new Map(), nextChan: 1`):

```typescript
      originated: new Set(),
```

In `placeCall`, take the new parameter and check it first:

```typescript
  placeCall(fromCode: string, to: CallTarget, on?: number):
      { chan: number } | RefusedReason {
    const from = this.exchanges.get(fromCode);
    if (!from) return "offline";
    // The one-hop cap. `on` names the channel this call answers; if that
    // channel arrived with an origin, the caller is relaying, and relaying is
    // what makes loops possible.
    if (on !== undefined && from.originated.has(on)) return "depth";
```

and mark the callee's new channel as originated, immediately after `target.channels.set(...)`:

```typescript
    target.originated.add(calleeChan);
```

Clear it wherever a channel is removed. In `closeChannel`, after `ex.channels.delete(chan)`, and in `handleHostFrame`'s `CLOSE` branch after `ex.channels.delete(f.chan)`:

```typescript
    ex.originated.delete(chan);   // closeChannel
    ex.originated.delete(f.chan); // handleHostFrame
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"` — all pass.
Then `npm test` for the whole suite.

- [ ] **Step 5: Document the limit honestly**

Add above `placeCall`'s `on` check, because a future reader will ask:

```typescript
    // Honesty about the boundary: `on` is supplied by the host, and the hub
    // cannot see causality. An honest host sets it and cannot relay; a
    // dishonest one could omit it. This is loop prevention for a federation of
    // cooperating hosts, not a defence against a hostile one — the channel cap
    // (maxChannels) is what bounds a bad actor's blast radius.
```

- [ ] **Step 6: Commit**

```bash
git add emulator/relay/src/trunk.ts emulator/relay/tests/trunk.test.ts
git commit -m "feat(trunk): one hop — an originated call may not place another"
```

---

### Task 4: The server routes PLACE

**Files:**
- Modify: `emulator/relay/src/server.ts` (the `trunkWss.on("connection")` handler)
- Test: `emulator/relay/tests/switchboard-server.test.ts`

**Interfaces:**
- Consumes: Task 3's `placeCall(fromCode, to, on?)`.
- Produces: the `/trunk` leg answering `PLACE` with `PLACED` or `REFUSED`. Task 5's host talks to this.

- [ ] **Step 1: Write the failing test**

Append to `emulator/relay/tests/switchboard-server.test.ts`, following the two-host pattern already in that file:

```typescript
test("trunk leg: PLACE gets PLACED, and a bad target gets REFUSED", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const a = new WebSocket(`ws://127.0.0.1:${server.port}/trunk`);
  const b = new WebSocket(`ws://127.0.0.1:${server.port}/trunk`);
  const seenA: any[] = [], seenB: any[] = [];
  a.on("message", (d) => seenA.push(JSON.parse(d.toString())));
  b.on("message", (d) => seenB.push(JSON.parse(d.toString())));
  try {
    await Promise.all([
      new Promise((r) => a.once("open", r)), new Promise((r) => b.once("open", r)),
    ]);
    a.send(JSON.stringify({ t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US",
                            joshua: "period", world: 1, slot: "WOPR" }));
    b.send(JSON.stringify({ t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US",
                            joshua: "period", world: 1, slot: "PANAM" }));
    await waitFor(() => seenA.some((f) => f.t === "ASSIGNED") &&
                        seenB.some((f) => f.t === "ASSIGNED"));

    a.send(JSON.stringify({ t: "PLACE", call: 11, to: { world: 1, slot: "PANAM" } }));
    await waitFor(() => seenA.some((f) => f.t === "PLACED"));
    const placed = seenA.find((f) => f.t === "PLACED");
    assert.equal(placed.call, 11, "the reply must carry the caller's own call id");
    await waitFor(() => seenB.some((f) => f.t === "OPEN"));
    assert.deepEqual(seenB.find((f) => f.t === "OPEN").origin, { world: 1, slot: "WOPR" });

    a.send(JSON.stringify({ t: "PLACE", call: 12, to: { world: 9, slot: "PACTEL" } }));
    await waitFor(() => seenA.some((f) => f.t === "REFUSED"));
    const refused = seenA.find((f) => f.t === "REFUSED");
    assert.equal(refused.call, 12);
    assert.equal(refused.reason, "offline");
  } finally {
    a.close(); b.close(); await server.close();
  }
});

test("trunk leg: a PLACE before REGISTER is ignored, not a crash", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const a = new WebSocket(`ws://127.0.0.1:${server.port}/trunk`);
  const seen: any[] = [];
  a.on("message", (d) => seen.push(JSON.parse(d.toString())));
  try {
    await new Promise((r) => a.once("open", r));
    a.send(JSON.stringify({ t: "PLACE", call: 1, to: { world: 1, slot: "PANAM" } }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 0, "an unregistered socket must get no reply");
    assert.equal(a.readyState, WebSocket.OPEN, "and must not be closed for trying");
  } finally {
    a.close(); await server.close();
  }
});
```

If `waitFor` does not already exist in that file, add it at the top:

```typescript
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.ok(cond(), "condition never became true");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/switchboard-server.test.ts"`
Expected: the first FAILS — no `PLACED` ever arrives, because `handleHostFrame` ignores `PLACE`.

- [ ] **Step 3: Route it**

In `src/server.ts`, inside `trunkWss.on("connection", ...)`, in the `host.on("message")` handler, add a branch before the existing `if (code !== null) switchboard.handleHostFrame(code, f);`:

```typescript
      if (f.t === "PLACE") {
        // A PLACE before REGISTER has no caller to bill it to. Ignore it
        // rather than closing: the host is mid-handshake, not hostile.
        if (code === null) return;
        const r = switchboard.placeCall(code, f.to, f.on);
        host.send(JSON.stringify(typeof r === "string"
          ? { t: "REFUSED", call: f.call, reason: r }
          : { t: "PLACED", call: f.call, chan: r.chan }));
        return;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/switchboard-server.test.ts"` — all pass.
Then `npm test` and `npm run typecheck`.

- [ ] **Step 5: Commit**

```bash
git add emulator/relay/src/server.ts emulator/relay/tests/switchboard-server.test.ts
git commit -m "feat(trunk): the /trunk leg answers PLACE"
```

---

### Task 5: The host side can place and receive

**Files:**
- Modify: `emulator/relay/src/tieline.ts`
- Test: `emulator/relay/tests/tieline.test.ts`

**Interfaces:**
- Consumes: the wire from Tasks 1–4.
- Produces: on the object `startTieline` returns, `place(to: CallTarget, on?: number): Promise<{ chan: number } | RefusedReason>` and `assigned(): boolean`; and an `onOpen` option gaining a second argument, `origin?: CallOrigin`.
  I checked: `assigned()` does **not** exist today. The tieline already tracks whether it has been placed (it is what the reconnect path keys off); this exposes that flag so Task 6 can wait for registration before calling. One accessor, no new state.

- [ ] **Step 1: Write the failing test**

Read `tests/tieline.test.ts`'s existing fake-hub pattern first — a `WebSocketServer` that answers `REGISTER` with `ASSIGNED` — and follow it:

```typescript
test("tieline: place() resolves with the hub's PLACED, and rejects nothing", async () => {
  const hub = new WebSocketServer({ port: 0 });
  hub.on("connection", (ws) => {
    ws.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.t === "REGISTER") {
        ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 1, slot: "WOPR" }));
      } else if (f.t === "PLACE" && f.to.slot === "PANAM") {
        ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 5 }));
      } else if (f.t === "PLACE") {
        ws.send(JSON.stringify({ t: "REFUSED", call: f.call, reason: "offline" }));
      }
    });
  });
  await new Promise<void>((r) => hub.once("listening", () => r()));
  const port = (hub.address() as { port: number }).port;

  const seenOrigins: unknown[] = [];
  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "LIVE EXCH", region: "SEATTLE US",
    joshua: "period", localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    onOpen: (_chan: number, origin?: unknown) => { seenOrigins.push(origin); },
  });
  try {
    const ok = await tie.place({ world: 1, slot: "PANAM" });
    assert.deepEqual(ok, { chan: 5 });
    const no = await tie.place({ world: 1, slot: "PACTEL" });
    assert.equal(no, "offline");
  } finally {
    tie.stop();
    await new Promise<void>((r) => hub.close(() => r()));
  }
});

test("tieline: an inbound OPEN hands its origin to onOpen", async () => {
  const hub = new WebSocketServer({ port: 0 });
  hub.on("connection", (ws) => {
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).t !== "REGISTER") return;
      ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "FAKE01", world: 1, slot: "WOPR" }));
      ws.send(JSON.stringify({ t: "OPEN", chan: 3, query: "",
                               origin: { world: 1, slot: "PANAM" } }));
    });
  });
  await new Promise<void>((r) => hub.once("listening", () => r()));
  const port = (hub.address() as { port: number }).port;

  const seen: unknown[] = [];
  const tie = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "LIVE EXCH", region: "SEATTLE US",
    joshua: "period", localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    onOpen: (_chan: number, origin?: unknown) => { seen.push(origin); },
  });
  try {
    const deadline = Date.now() + 3000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual(seen[0], { world: 1, slot: "PANAM" });
  } finally {
    tie.stop();
    await new Promise<void>((r) => hub.close(() => r()));
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"`
Expected: FAIL — `tie.place is not a function`.

- [ ] **Step 3: Implement `place()` and pass `origin` through**

In `src/tieline.ts`: import `CallOrigin`, `CallTarget` and `RefusedReason` from `./trunk.ts`; add a pending map and a call counter beside the existing per-connection state:

```typescript
  const placing = new Map<number, (r: { chan: number } | RefusedReason) => void>();
  let nextCall = 1;
```

Handle the two replies where the other inbound frames are handled:

```typescript
      } else if (f.t === "PLACED") {
        placing.get(f.call)?.({ chan: f.chan });
        placing.delete(f.call);
      } else if (f.t === "REFUSED") {
        placing.get(f.call)?.(f.reason);
        placing.delete(f.call);
      }
```

Pass the origin to the existing `onOpen` callback where `OPEN` is handled — add `f.origin` as its second argument.

Add `place` to the returned object:

```typescript
    place(to: CallTarget, on?: number): Promise<{ chan: number } | RefusedReason> {
      // No socket, no call: resolve rather than reject, so a caller handles
      // "could not place" in one branch instead of a try/catch plus a branch.
      if (!hub || hub.readyState !== WebSocket.OPEN) return Promise.resolve("offline");
      const call = nextCall++;
      return new Promise((resolve) => {
        placing.set(call, resolve);
        hub.send(JSON.stringify({ t: "PLACE", call, on, to }));
      });
    },
```

Clear `placing` wherever the connection drops, resolving each waiter with `"offline"` — a promise that never settles is worse than a refusal:

```typescript
    for (const resolve of placing.values()) resolve("offline");
    placing.clear();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"` — all pass, including the pre-existing reconnect tests.
Then `npm test` and `npm run typecheck`.

**Note on a known-flaky neighbour:** `tieline.test.ts`'s "a 4400 AFTER the placement is an outage" has a race — it waits for `connections >= 2` then asserts `assignedCalls >= 2`, and a second connection does not imply a second ASSIGNED. It fails occasionally under load. If you see it fail, re-run before investigating; it is not caused by this task. Do not fix it here.

- [ ] **Step 5: Commit**

```bash
git add emulator/relay/src/tieline.ts emulator/relay/tests/tieline.test.ts
git commit -m "feat(tieline): a host can place a call and see who called it"
```

---

### Task 6: End to end, over real sockets

**Files:**
- Modify: `emulator/relay/tests/trunk-e2e.test.ts`

**Interfaces:**
- Consumes: everything above. Produces nothing.

- [ ] **Step 1: Write the failing test**

Follow the existing e2e file's shape — it starts a real `startServer` and real tielines:

```typescript
test("e2e: one exchange calls another's slot, and frames cross both ways", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hubUrl = `ws://127.0.0.1:${server.port}/trunk`;
  const inboundA: Array<{ chan: number; origin?: unknown }> = [];
  const inboundB: Array<{ chan: number; origin?: unknown }> = [];

  const a = startTieline({ hubUrl, name: "A EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "WOPR", localComms: "ws://127.0.0.1:9",
    localBridge: "http://127.0.0.1:9",
    onOpen: (chan: number, origin?: unknown) => { inboundA.push({ chan, origin }); } });
  const b = startTieline({ hubUrl, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM", localComms: "ws://127.0.0.1:9",
    localBridge: "http://127.0.0.1:9",
    onOpen: (chan: number, origin?: unknown) => { inboundB.push({ chan, origin }); } });

  try {
    // Both must be ASSIGNED before either can place.
    const deadline = Date.now() + 5000;
    while ((!a.assigned() || !b.assigned()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(a.assigned() && b.assigned(), "both tielines must register first");

    const placed = await a.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object", `A could not call B: ${JSON.stringify(placed)}`);

    while (inboundB.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(inboundB.length, 1, "B never saw the inbound call");
    assert.deepEqual(inboundB[0].origin, { world: 1, slot: "WOPR" },
      "B must be told which slot called it");
    assert.equal(inboundA.length, 0, "A placed the call; it must not also receive one");
  } finally {
    a.stop(); b.stop(); await server.close();
  }
});
```

`assigned()` comes from Task 5. If it is missing, that task was left incomplete — go back and add it there rather than inlining a substitute here, so the accessor lives with the rest of the tieline's public surface.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk-e2e.test.ts"`
Expected: FAIL before the earlier tasks are in; if they are, this should pass first time — in which case confirm it genuinely exercises the path by breaking `placeCall` temporarily and seeing it fail, then restoring.

- [ ] **Step 3: Make it pass**

No new production code should be needed. If it fails, the defect is in Tasks 2–5; fix it there rather than in the test.

- [ ] **Step 4: Full verification**

```bash
cd emulator/relay && npm run typecheck && npm test
cd ../.. && make test
```
Expected: relay green (183 + the new tests), golden fixtures 348 unchanged — piece A touches no program.

- [ ] **Step 5: Commit**

```bash
git add emulator/relay/tests/trunk-e2e.test.ts emulator/relay/src/tieline.ts
git commit -m "test(trunk): two exchanges, one real call, end to end"
```

---

## Self-Review

**Spec coverage (§1 Piece A):** the wire → Task 1. `origin`'s two shapes → Task 1, exercised in 2 and 5. `REFUSED`'s six reasons → Task 1 (codec) and Task 2 (`offline`/`busy`/`self`/`seat-gone`/`oversize`), Task 3 (`depth`). Numbering, both channels allocated by the hub → Task 2. The depth cap → Task 3. `OPEN` stays hub→host → enforced by never adding it to any host send path; asserted in Task 6 (`inboundA.length === 0`). Testing plan → Tasks 2, 3, 4, 5 unit; Task 6 e2e. No gaps.

**Deliberately deferred to piece B:** the seat leg, seat handles, ringing, `origin: { seat }` on visitor `OPEN`s. The codec accepts the seat *shape* now (Task 1) so B changes the switchboard, not the wire — stated in Global Constraints and enforced by Task 2's `seat-gone`.

**Placeholder scan:** none. Every step carries runnable code. Two assumptions were checked against the repo rather than assumed: `maxChannels` is a real `Switchboard` constructor option (default 16), so Task 2's `{ maxChannels: 1 }` test works; and `assigned()` does not exist today, so Task 5 owns adding it.

**Type consistency:** `CallOrigin`, `CallTarget`, `RefusedReason` defined in Task 1 and used by name in 2, 3, 5. `placeCall(fromCode, to)` in Task 2 gains `on?` in Task 3, and Task 4 passes `f.on` to that signature. `peerPort(peer, peerChan)` is Task 2's only new private method. `place(to, on?)` in Task 5 matches what Task 6 calls.
