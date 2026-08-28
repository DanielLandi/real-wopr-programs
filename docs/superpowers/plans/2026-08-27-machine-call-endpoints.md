# Machine Call Endpoints and the Ringable Seat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a machine call a real endpoint at each end, and make a visitor's seat ringable by a machine it has already called.

**Architecture:** Each end of a call attaches to whatever that end already is. A program attaches through an ordinary bridge session dialled over its own `/link` (a new `local-leg.ts`, used by the callee tieline, the caller tieline, and the hub's own seeded slots). A seat attaches through the socket the visitor already holds open (a new `/seat` leg plus a `seats.ts` registry that owns handles and rings). World 1's seeded slots stop being a directory fiction and become real `Exchange` records with an in-process port, so the flagship can place and receive calls.

**Tech Stack:** TypeScript on Node ≥ 23.6 (native type-stripping, `.ts` run directly), `ws`, `node:test`.

**Spec:** `../real-wopr/docs/superpowers/specs/2026-08-27-machine-call-endpoints-design.md`. Read it — this plan argues from it. Its parent is `2026-08-24-worlds-phase-2-design.md` (§1 piece A, §2 piece B).

## Global Constraints

- **Node ≥ 23.6.** Run all tests with `npm test` in `emulator/relay`; one file with `node --test --test-force-exit "tests/<file>"`.
- **Determinism.** No wall clock, no unseeded randomness in tests. `SeatRegistry` takes an injected `newId` and an injected timer; the ring timeout is `ringTimeoutMs`, default `30_000`.
- **The answering end paces.** Exactly one `LinkShaper` per call, at the end that answers. A calling end never shapes.
- **The seat token never crosses the trunk.** The hub strips `seat` from the query before building an `OPEN`.
- **`Exchange.originated` keeps its meaning:** "arrived from a machine", written by `placeCall` and nothing else. Never add to it from an `OPEN`'s `origin` presence.
- **Frame cap.** Every frame the hub emits stays within `TRUNK_MAX_FRAME_BYTES` (8192); refuse `oversize` rather than send a frame the peer's decoder drops.
- **The hub never inspects payloads.** `data` stays opaque; only its type is checked.
- **`HOME` is never a slot.** It stays off `NAMED_SLOTS`, off the directory, and unregisterable.
- **Refused reasons stay a closed set:** `offline`, `busy`, `seat-gone`, `depth`, `oversize`, `self`.
- **Tier A repo.** Branch → PR → nine required checks green → `gh pr merge --squash`. No direct push to `main`.

## File Structure

| File | Responsibility |
| --- | --- |
| `emulator/relay/src/local-leg.ts` | **new** — mint a session on a bridge, dial `/link`, pipe it to a channel |
| `emulator/relay/src/seats.ts` | **new** — seat legs, per-(seat, exchange) handles, ring state |
| `emulator/relay/src/config.ts` | two new surfaces: `trunk-call`, `trunk-caller` |
| `emulator/relay/src/trunk.ts` | seeded slots as real exchanges; `placeCall`'s seat branch |
| `emulator/relay/src/tieline.ts` | attach a local leg at both ends of a machine call |
| `emulator/relay/src/server.ts` | `/seat`, `POST /trunk/place`, `seat=` stripping, the seeded port |
| `emulator/relay/tests/local-leg.test.ts` | **new** |
| `emulator/relay/tests/seats.test.ts` | **new** |
| `emulator/relay/tests/{trunk,tieline,server,worlds,trunk-e2e}.test.ts` | extended |

Two new modules rather than growth in `trunk.ts` (already the largest source file at 637 lines): the handle capability rule is the security-relevant part of this work and belongs where it can be unit-tested against a small object rather than a fixture built from two live trunk sockets.

---

### Task 1: `local-leg.ts` — one end of a machine call

**Files:**
- Create: `emulator/relay/src/local-leg.ts`
- Modify: `emulator/relay/src/config.ts` (`DEFAULT_CONFIG.surface_links`)
- Test: `emulator/relay/tests/local-leg.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  export interface LocalLegOpts {
    bridgeUrl: string;            // http://127.0.0.1:8000
    commsUrl: string;             // ws://127.0.0.1:8081
    surface: "trunk-call" | "trunk-caller";
    system?: string;              // seeded period systems
    origin?: string;              // "world 1 slot PANAM" | "seat <handle>"
    filterRitual?: boolean;       // caller side: drop handshake/control
    send: (data: string) => void;
    close: (reason?: string) => void;
  }
  export interface LocalLeg { deliver(data: string): void; close(reason?: string): void }
  export async function openLocalLeg(opts: LocalLegOpts): Promise<LocalLeg | "refused">
  ```

- [ ] **Step 1: Add the two surfaces**

In `src/config.ts`, inside `DEFAULT_CONFIG.surface_links`, after `"wopr-panel"`:

```typescript
    // A machine that ANSWERS a machine runs the same ritual a person's call
    // runs — 1200 baud is the period read of a business line between two
    // installations, faster than David's 600-baud home line and slower than
    // NORAD's leased circuit.
    "trunk-call": "dialup-1200",
    // A machine that PLACES a call must not shape: the answering end already
    // paces the call, and two shapers in series halve throughput and double
    // latency for no fiction. `off` is baud 0, handshake "none".
    "trunk-caller": "off",
```

- [ ] **Step 2: Write the failing tests**

Create `emulator/relay/tests/local-leg.test.ts`:

```typescript
// local-leg: the end of a machine call that is a program. It mints an ordinary
// bridge session and dials an ordinary /link, so a machine answering a machine
// runs the same code path that answers a person.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";
import { openLocalLeg } from "../src/local-leg.ts";
import { decodeEnvelope, encodeEnvelope } from "../src/envelope.ts";

/** A bridge that mints one session, and a comms leg that records the URL it
 *  was dialled on and echoes envelopes the test pushes at it. */
async function stubs(opts: { mintStatus?: number } = {}): Promise<{
  bridgeUrl: string; commsUrl: string;
  dialled: string[]; sessionPosts: string[]; received: string[];
  push: (kind: string, payload: string) => void;
  close: () => Promise<void>;
}> {
  const sessionPosts: string[] = [];
  const bridge = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/api/session") {
        sessionPosts.push(Buffer.concat(chunks).toString());
        const status = opts.mintStatus ?? 201;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(status === 201 ? JSON.stringify({ session_id: "S1", token: "T1" }) : "{}");
        return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => bridge.listen(0, r));

  const dialled: string[] = [];
  const received: string[] = [];
  const sockets: import("ws").WebSocket[] = [];
  const wss = new WebSocketServer({ port: 0 });
  wss.on("connection", (ws, req) => {
    dialled.push(req.url ?? "");
    sockets.push(ws);
    ws.on("message", (d) => received.push(d.toString()));
  });
  await new Promise<void>((r) => wss.once("listening", r));

  return {
    bridgeUrl: `http://127.0.0.1:${(bridge.address() as { port: number }).port}`,
    commsUrl: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    dialled, sessionPosts, received,
    push: (kind, payload) => {
      for (const s of sockets) {
        s.send(encodeEnvelope({ v: 1, session: "S1", seq: 0, kind: kind as never,
                                link: "trunk-call", payload, eom: true }));
      }
    },
    close: () => new Promise<void>((r) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => bridge.close(() => r()));
    }),
  };
}

const settle = () => new Promise((r) => setTimeout(r, 60));

test("local-leg: mints a session and dials /link with it", async () => {
  const s = await stubs();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.notEqual(leg, "refused");
    await settle();
    assert.equal(s.sessionPosts.length, 1);
    assert.match(s.sessionPosts[0], /"surface":"trunk-call"/);
    assert.equal(s.dialled.length, 1);
    assert.match(s.dialled[0], /surface=trunk-call/);
    assert.match(s.dialled[0], /session=S1/);
    assert.match(s.dialled[0], /token=T1/);
  } finally { await s.close(); }
});

test("local-leg: announces the origin as a control envelope before anything else", async () => {
  const s = await stubs();
  try {
    await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      origin: "world 1 slot PANAM", send: () => {}, close: () => {},
    });
    await settle();
    const first = decodeEnvelope(s.received[0]);
    assert.equal(first.kind, "control");
    assert.equal(first.payload, "ORIGIN world 1 slot PANAM");
  } finally { await s.close(); }
});

test("local-leg: buffers what arrives before the socket opens", async () => {
  const s = await stubs();
  try {
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: () => {},
    });
    assert.notEqual(leg, "refused");
    (leg as { deliver: (d: string) => void }).deliver("EARLY");
    await settle();
    assert.ok(s.received.includes("EARLY"), "a frame delivered before open must not be lost");
  } finally { await s.close(); }
});

test("local-leg: the caller side drops the ritual, the callee side keeps it", async () => {
  const caller = await stubs();
  try {
    const out: string[] = [];
    await openLocalLeg({
      bridgeUrl: caller.bridgeUrl, commsUrl: caller.commsUrl, surface: "trunk-caller",
      filterRitual: true, send: (d) => out.push(d), close: () => {},
    });
    await settle();
    caller.push("handshake", "CARRIER DETECT");
    caller.push("control", "NO CARRIER");
    caller.push("output", "GREETINGS");
    await settle();
    const kinds = out.map((d) => decodeEnvelope(d).kind);
    assert.deepEqual(kinds, ["output"],
      "a calling program must not be handed the answering modem's ritual");
  } finally { await caller.close(); }
});

test("local-leg: a refused mint is a close with a reason, never a hang", async () => {
  const s = await stubs({ mintStatus: 400 });
  try {
    const closes: Array<string | undefined> = [];
    const leg = await openLocalLeg({
      bridgeUrl: s.bridgeUrl, commsUrl: s.commsUrl, surface: "trunk-call",
      send: () => {}, close: (reason) => closes.push(reason),
    });
    assert.equal(leg, "refused");
    assert.equal(closes.length, 1);
    assert.match(closes[0] ?? "", /session/i);
  } finally { await s.close(); }
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/local-leg.test.ts"`
Expected: every test FAILS — `Cannot find module '../src/local-leg.ts'`.

- [ ] **Step 4: Write `src/local-leg.ts`**

```typescript
// One end of a machine call that is a program.
//
// A machine answering a machine should not be a special code path: it mints an
// ordinary bridge session and dials an ordinary /link, so it gets the same
// ritual, the same pacing and the same program a visitor's call gets. The only
// thing that differs is who dialled.
//
// Three call sites: the callee tieline (an inbound machine call), the caller
// tieline (a call this host placed), and the hub's own seeded world-1 slots.
// Written once, because the copy nobody runs in a test is the one that rots.

import { WebSocket } from "ws";
import { encodeEnvelope, decodeEnvelope } from "./envelope.ts";

export interface LocalLegOpts {
  bridgeUrl: string;
  commsUrl: string;
  surface: "trunk-call" | "trunk-caller";
  system?: string;
  /** Who called, as the program will be told: "world 1 slot PANAM" or
   *  "seat <handle>". The ONE way a program learns this, on every path —
   *  including the seeded-slot path, where no OPEN exists to carry a field. */
  origin?: string;
  /** Caller side. The answering end's handshake and control frames travel back
   *  over the trunk (that is how a visitor sees CARRIER DETECT), but a calling
   *  PROGRAM must not be handed them as input: no period program ever had to
   *  answer its own modem. */
  filterRitual?: boolean;
  send: (data: string) => void;
  close: (reason?: string) => void;
}

export interface LocalLeg {
  deliver(data: string): void;
  close(reason?: string): void;
}

export async function openLocalLeg(opts: LocalLegOpts): Promise<LocalLeg | "refused"> {
  let minted: { session_id: string; token: string };
  try {
    const res = await fetch(`${opts.bridgeUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: opts.surface, system: opts.system ?? null }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { opts.close("no session"); return "refused"; }
    minted = await res.json() as { session_id: string; token: string };
  } catch {
    opts.close("no session"); return "refused";
  }

  const url = `${opts.commsUrl}/link?surface=${encodeURIComponent(opts.surface)}` +
              `&session=${encodeURIComponent(minted.session_id)}` +
              `&token=${encodeURIComponent(minted.token)}`;
  const local = new WebSocket(url);
  const buffer: string[] = [];
  let open = false;

  const push = (data: string) => {
    if (open) local.send(data); else buffer.push(data);
  };

  local.on("open", () => {
    open = true;
    // The origin goes first, ahead of anything the far end already said. The
    // /link leg forwards an unrecognized control envelope straight upstream,
    // and buffers it if the bridge socket is not up yet, so this cannot race.
    if (opts.origin !== undefined) {
      local.send(encodeEnvelope({
        v: 1, session: minted.session_id, seq: 0, kind: "control",
        link: opts.surface, payload: `ORIGIN ${opts.origin}`, eom: true,
      }));
    }
    for (const d of buffer.splice(0)) local.send(d);
  });

  local.on("message", (data) => {
    const text = data.toString();
    if (opts.filterRitual) {
      try {
        const kind = decodeEnvelope(text).kind;
        if (kind !== "output" && kind !== "prompt") return;
      } catch {
        return;   // not an envelope we can classify; do not feed it to a program
      }
    }
    opts.send(text);
  });

  const drop = () => opts.close("local leg closed");
  local.on("close", drop);
  local.on("error", drop);

  return {
    deliver: push,
    close: () => { try { local.close(); } catch { /* already closed */ } },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/local-leg.test.ts"`
Expected: 5 tests PASS.

- [ ] **Step 6: Typecheck**

Run: `cd emulator/relay && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add emulator/relay/src/local-leg.ts emulator/relay/src/config.ts emulator/relay/tests/local-leg.test.ts
git commit -m "A machine call gets an end that is a program

openLocalLeg mints an ordinary bridge session and dials an ordinary
/link, so a machine answering a machine runs the code path that answers
a person. Two surfaces: trunk-call answers and paces at 1200 baud,
trunk-caller places and does not pace, because the answering end
already did."
```

---

### Task 2: The callee tieline discriminates on the origin's shape

**Files:**
- Modify: `emulator/relay/src/tieline.ts` (`openChannel`, lines 64-72)
- Test: `emulator/relay/tests/tieline.test.ts`

**Interfaces:**
- Consumes: `openLocalLeg`, `LocalLeg` from Task 1.
- Produces: nothing new on the tieline's public surface. `onOpen(chan, origin?)` is unchanged.

**Why this is the trap.** Piece A could read `origin`'s *presence* as "a machine called", because only a machine call carried one. The moment a seat handle exists, a visitor's `OPEN` carries `origin: { seat }` too. `openChannel` pastes the hub's query into its local dial — right for a visitor, whose query is real; catastrophic for a machine call, which has none. From here the **shape** decides. (`Exchange.originated` on the hub side already reads "from a machine" and is written only by `placeCall` — see `trunk.ts:207-212`. Task 4 pins that with a test; do not change it.)

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/tieline.test.ts`:

```typescript
test("tieline: an OPEN from a machine opens a local leg, not a query dial", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", () => {});
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    hostSocket!.send(JSON.stringify({
      t: "OPEN", chan: 1, query: "", origin: { world: 1, slot: "PANAM" } }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bridge.sessionPosts.length, 1, "a machine call must mint its own session");
    assert.match(dialled.at(-1) ?? "", /surface=trunk-call/);
    assert.match(dialled.at(-1) ?? "", /session=/);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: an OPEN from a seat still pastes the hub's query", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", () => {});
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    hostSocket!.send(JSON.stringify({
      t: "OPEN", chan: 2, query: "surface=home-terminal&session=S9&token=T9",
      origin: { seat: "HDL1" } }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bridge.sessionPosts.length, 0, "a visitor already has a session");
    assert.match(dialled.at(-1) ?? "", /session=S9/);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});
```

- [ ] **Step 2: Give `startStubComms` a dial recorder**

The existing helper (`tests/tieline.test.ts:51`) ignores the URL. Change its `connection` handler to:

```typescript
async function startStubComms(): Promise<{
  port: number; onDial?: (url: string) => void; close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0 });
  const self = {
    port: 0,
    onDial: undefined as ((url: string) => void) | undefined,
    close: () => new Promise<void>((resolve) => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
  wss.on("connection", (ws, req) => {
    self.onDial?.(req.url ?? "");
    ws.on("message", (data) => ws.send(data.toString()));
  });
  await new Promise<void>((r) => wss.once("listening", r));
  self.port = (wss.address() as { port: number }).port;
  return self;
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"`
Expected: the machine-call test FAILS — no session is minted, and the dial URL is `/link?` with an empty query.

- [ ] **Step 4: Implement the discrimination**

Replace `openChannel` in `src/tieline.ts`:

```typescript
  /** An inbound call. WHO called decides what it attaches to locally, and the
   *  SHAPE of `origin` is what says who — never its presence. Once seats exist
   *  every inbound OPEN carries an origin: a visitor's is `{ seat }`. Reading
   *  the presence here would send every relayed visitor's call to an empty
   *  local leg. */
  function openChannel(f: Extract<TrunkFrame, { t: "OPEN" }>): void {
    const fromMachine = f.origin !== undefined && "slot" in f.origin;
    if (fromMachine) { void openMachineChannel(f); return; }

    const local = new WebSocket(`${opts.localComms}/link?${f.query}`);
    const entry = { local, buffer: [] as string[] };
    channels.set(f.chan, entry);
    local.on("open", () => { for (const d of entry.buffer.splice(0)) local.send(d); });
    local.on("message", (data) => send({ t: "FRAME", chan: f.chan, data: data.toString() }));
    const drop = () => {
      if (channels.delete(f.chan)) { send({ t: "CLOSE", chan: f.chan }); opts.onClose?.(f.chan); }
    };
    local.on("close", drop);
    local.on("error", drop);
    opts.onOpen?.(f.chan, f.origin);
  }

  /** A machine called. There is no visitor query to paste — this host mints an
   *  ordinary session of its own and dials its own /link, so the program
   *  answers a machine exactly as it answers a person. */
  async function openMachineChannel(f: Extract<TrunkFrame, { t: "OPEN" }>): Promise<void> {
    const o = f.origin as { world: number; slot: string };
    const leg = await openLocalLeg({
      bridgeUrl: opts.localBridge,
      commsUrl: opts.localComms,
      surface: "trunk-call",
      origin: `world ${o.world} slot ${o.slot}`,
      send: (data) => send({ t: "FRAME", chan: f.chan, data }),
      close: (reason) => {
        if (legs.delete(f.chan)) { send({ t: "CLOSE", chan: f.chan, reason }); opts.onClose?.(f.chan, reason); }
      },
    });
    if (leg === "refused") return;
    legs.set(f.chan, leg);
    opts.onOpen?.(f.chan, f.origin);
  }
```

Add near the `channels` map at the top of `startTieline`:

```typescript
  // Machine-call ends, keyed by the same channel numbers `channels` uses. A
  // channel is in exactly one of the two maps: a visitor's dial or a machine's
  // local leg.
  const legs = new Map<number, LocalLeg>();
```

Extend the `FRAME` and `CLOSE` handlers in `hub.on("message")`:

```typescript
      } else if (f.t === "FRAME") {
        const leg = legs.get(f.chan);
        if (leg) { leg.deliver(f.data); return; }
        const c = channels.get(f.chan);
        if (!c) return;
        if (c.local.readyState === WebSocket.OPEN) c.local.send(f.data);
        else c.buffer.push(f.data);
      } else if (f.t === "CLOSE") {
        legs.get(f.chan)?.close(); legs.delete(f.chan);
        channels.get(f.chan)?.local.close(); channels.delete(f.chan);
        opts.onClose?.(f.chan, f.reason);
      }
```

And in `retry()`, alongside the existing channel teardown:

```typescript
      for (const leg of legs.values()) leg.close();
      legs.clear();
```

Add to the imports at the top of the file:

```typescript
import { openLocalLeg, type LocalLeg } from "./local-leg.ts";
```

Add to `TielineOpts`:

```typescript
  /** Fires when any channel ends — one this host placed or one it answered.
   *  A placer is otherwise never told the callee hung up. */
  onClose?: (chan: number, reason?: string) => void;
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"`
Expected: all tests PASS, including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add emulator/relay/src/tieline.ts emulator/relay/tests/tieline.test.ts
git commit -m "The origin's shape decides what an inbound call attaches to

Piece A could read origin's presence as 'a machine called'. Once a seat
handle exists a visitor's OPEN carries one too, so the shape decides:
{ slot } mints a local session, { seat } pastes the visitor's own query.
Reading the presence would send every relayed visitor to an empty leg."
```

---

### Task 3: `place()` resolves a call the host can hang up

**Files:**
- Modify: `emulator/relay/src/tieline.ts` (the returned object's `place`, lines 158-215)
- Test: `emulator/relay/tests/tieline.test.ts`

**Interfaces:**
- Consumes: `openLocalLeg` (Task 1), the `legs` map and `onClose` (Task 2).
- Produces: `place(to: CallTarget, on?: number): Promise<PlacedCall | RefusedReason>` where
  ```typescript
  export interface PlacedCall { chan: number; close(reason?: string): void }
  ```

**Why there is no `send(chan, data)`.** A host does not narrate a call; its *program* does, through a session of its own. `place()` attaches a `trunk-caller` leg automatically, and a fresh session's program greets on connect — which is piece D's beat, arriving for free rather than being built for it.

- [ ] **Step 1: Write the failing test**

Append to `emulator/relay/tests/tieline.test.ts`:

```typescript
test("tieline: a placed call attaches a local leg and can be hung up", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  const dialled: string[] = [];
  const fromHost: string[] = [];
  comms.onDial = (url: string) => dialled.push(url);
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      fromHost.push(f.t);
      if (f.t === "PLACE") ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 7 }));
    });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    const placed = await t.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object");
    const call = placed as { chan: number; close: (r?: string) => void };
    assert.equal(call.chan, 7);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(bridge.sessionPosts.length, 1, "the placer needs a program of its own");
    assert.match(dialled.at(-1) ?? "", /surface=trunk-caller/);

    call.close("done");
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(fromHost.includes("CLOSE"), "close() must reach the hub");
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});

test("tieline: the placer is told when the callee hangs up", async () => {
  const comms = await startStubComms();
  const bridge = await startStubBridge();
  const hub = new WebSocketServer({ port: 0 });
  let hostSocket: WebSocket | undefined;
  hub.on("connection", (ws) => {
    hostSocket = ws;
    ws.on("message", (d) => {
      const f = JSON.parse(d.toString());
      if (f.t === "PLACE") ws.send(JSON.stringify({ t: "PLACED", call: f.call, chan: 4 }));
    });
    ws.send(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" }));
  });
  const port = (hub.address() as { port: number }).port;
  const closed: Array<{ chan: number; reason?: string }> = [];
  const t = startTieline({
    hubUrl: `ws://127.0.0.1:${port}`, name: "A EXCH", region: "SEATTLE US",
    joshua: "period", reconnect: false,
    localComms: `ws://127.0.0.1:${comms.port}`,
    localBridge: `http://127.0.0.1:${bridge.port}`,
    onClose: (chan, reason) => closed.push({ chan, reason }),
  });
  try {
    await new Promise((r) => setTimeout(r, 100));
    await t.place({ world: 1, slot: "PANAM" });
    await new Promise((r) => setTimeout(r, 150));
    hostSocket!.send(JSON.stringify({ t: "CLOSE", chan: 4, reason: "call ended" }));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(closed, [{ chan: 4, reason: "call ended" }]);
  } finally {
    t.stop(); hub.close(); await comms.close(); await bridge.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"`
Expected: FAIL — `call.close is not a function`, and no session is minted for the placer.

- [ ] **Step 3: Attach a leg to a placed call**

In `src/tieline.ts`, add the exported type near `TielineOpts`:

```typescript
/** A call this host placed. There is deliberately no `send`: the caller's own
 *  PROGRAM talks, through the session `place()` attached, and a fresh session's
 *  program greets on connect. */
export interface PlacedCall { chan: number; close(reason?: string): void }
```

Change the return type of `startTieline` so `place` reads:

```typescript
  place: (to: CallTarget, on?: number) => Promise<PlacedCall | RefusedReason>;
```

Replace the `dial` helper's resolution inside `place()` so a `PLACED` becomes a
`PlacedCall` with a leg attached:

```typescript
      const attachPlaced = async (chan: number): Promise<PlacedCall> => {
        const hangUp = (reason?: string) => {
          legs.get(chan)?.close(); legs.delete(chan);
          send({ t: "CLOSE", chan, reason });
        };
        const leg = await openLocalLeg({
          bridgeUrl: opts.localBridge,
          commsUrl: opts.localComms,
          surface: "trunk-caller",
          filterRitual: true,
          send: (data) => send({ t: "FRAME", chan, data }),
          close: (reason) => {
            if (legs.delete(chan)) { send({ t: "CLOSE", chan, reason }); opts.onClose?.(chan, reason); }
          },
        });
        if (leg !== "refused") legs.set(chan, leg);
        return { chan, close: hangUp };
      };
```

and change the two `placing.get(f.call)?.(...)` sites in `hub.on("message")` to
await the attach:

```typescript
      else if (f.t === "PLACED") {
        const resolve = placing.get(f.call);
        placing.delete(f.call);
        if (resolve) void attachPlaced(f.chan).then(resolve);
      }
      else if (f.t === "REFUSED") { placing.get(f.call)?.(f.reason); placing.delete(f.call); }
```

Declare `attachPlaced` inside `startTieline` next to `openMachineChannel`, so
both the message handler and `place()` reach the same one. `placing`'s value
type becomes `(r: PlacedCall | RefusedReason) => void`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/tieline.test.ts"`
Expected: all PASS.

- [ ] **Step 5: Update the two callers of `place()`**

`tests/trunk-e2e.test.ts:404` asserts `typeof placed === "object"` — still true.
Check `src/main.ts` and `src/network-main.ts` for `place(` usage:

Run: `cd emulator/relay && grep -rn "\.place(" src tools 2>/dev/null`
Fix any call site that reads `.chan` off the result — the field is unchanged, so
this is expected to be a no-op; the step exists so the executor confirms it.

- [ ] **Step 6: Rewrite the `place()` doc comment**

Delete the `KNOWN GAP — issue #67` paragraph (`src/tieline.ts:172-182`) and
replace it with:

```typescript
     *  The returned call attaches a local leg of its own: a session on this
     *  host's bridge, dialled over this host's /link, whose program is what
     *  actually talks. Hang it up with close(); learn that the far end hung up
     *  from opts.onClose.
```

- [ ] **Step 7: Commit**

```bash
git add emulator/relay/src/tieline.ts emulator/relay/tests/tieline.test.ts
git commit -m "A placed call has an end, and can be hung up

place() resolves { chan, close } and attaches a trunk-caller session, so
the placing host's own program is what talks. onClose fires for any
channel, which is the third thing #67 named: a placer that was never
told the callee hung up."
```

---

### Task 4: World 1's seeded slots become real exchanges

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (`Exchange`, the constructor, `register`, `place`, `directory`, `sweepDead`, `unregister`, `openChannel`, `placeCall`)
- Test: `emulator/relay/tests/trunk.test.ts`, `emulator/relay/tests/worlds.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```typescript
  // On Switchboard:
  seedPort(slot: string, port: TrunkPort): string | undefined   // -> the seeded exchange's code
  seededCode(slot: string): string | undefined
  ```
  `Exchange` gains `seeded?: true`, `system?: string`, and `port` becomes `TrunkPort | null`.

**Why `port: TrunkPort | null` rather than a flag.** A seeded exchange exists from construction (the directory must list world 1 before the server has finished listening) but cannot have a port until the server knows its own address. Making the field nullable puts the compiler in charge of finding all eight places that send down a port, instead of a boolean that type-checks fine while doing the wrong thing.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/trunk.test.ts`:

```typescript
// ---- seeded world-1 slots are exchanges ----------------------------------

const SEEDS = [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" },
               { slot: "BANK", name: "UNION MARINE", region: "SEATTLE US", system: "umb" }];

test("seeded: a seeded slot has a code, and no port until one is attached", () => {
  const sb = new Switchboard({ localWorld: SEEDS, reservedWorlds: [] });
  const code = sb.seededCode("WOPR");
  assert.equal(typeof code, "string");
  const host = fakePort();
  const caller = codeOf(sb.register(host, {
    t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM" }));
  // No port attached yet: the slot is in the book but nothing answers it.
  assert.equal(sb.placeCall(caller, { world: 1, slot: "WOPR" }), "offline");
});

test("seeded: with a port attached, a seeded slot can be called", () => {
  const sb = new Switchboard({ localWorld: SEEDS, reservedWorlds: [] });
  const seedHost = fakePort();
  sb.seedPort("WOPR", seedHost);
  const host = fakePort();
  const caller = codeOf(sb.register(host, {
    t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM" }));
  const placed = sb.placeCall(caller, { world: 1, slot: "WOPR" });
  assert.equal(typeof placed, "object");
  const open = JSON.parse(seedHost.sent.at(-1)!);
  assert.equal(open.t, "OPEN");
  assert.deepEqual(open.origin, { world: 1, slot: "PANAM" });
});

test("seeded: a seeded slot can place a call of its own", () => {
  const sb = new Switchboard({ localWorld: SEEDS, reservedWorlds: [] });
  sb.seedPort("WOPR", fakePort());
  const host = fakePort();
  codeOf(sb.register(host, {
    t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM" }));
  const placed = sb.placeCall(sb.seededCode("WOPR")!, { world: 1, slot: "PANAM" });
  assert.equal(typeof placed, "object", "the flagship must be able to originate");
  const open = JSON.parse(host.sent.at(-1)!);
  assert.deepEqual(open.origin, { world: 1, slot: "WOPR" });
});

test("seeded: a seeded slot is still slot-taken for a keyed REGISTER", () => {
  const sb = new Switchboard({ localWorld: SEEDS, reserveKey: "K", reservedWorlds: [1] });
  assert.equal(sb.register(fakePort(), {
    t: "REGISTER", v: 1, name: "IMPOSTOR", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "WOPR", key: "K" }), "slot-taken");
});

test("seeded: maxExchanges counts registrants, not seeds", () => {
  const sb = new Switchboard({ localWorld: SEEDS, maxExchanges: 1, reservedWorlds: [] });
  assert.equal(typeof sb.register(fakePort(), {
    t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US", joshua: "period" }), "object");
  assert.equal(sb.register(fakePort(), {
    t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US", joshua: "period" }), "full");
});

test("seeded: a seeded slot survives a PING sweep", () => {
  const sb = new Switchboard({ localWorld: SEEDS, reservedWorlds: [] });
  sb.seedPort("WOPR", fakePort());
  sb.sweepDead(); sb.sweepDead(); sb.sweepDead();
  assert.equal(flatDir(sb, "https://hub").filter((e) => e.slot === "WOPR").length, 1,
    "a seeded slot is not a socket and cannot die");
});

// ---- the depth cap's predicate is "from a machine", not "has an origin" ---

test("depth: a machine a PERSON called may still call onward", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = codeOf(sb.register(fakePort(), {
    t: "REGISTER", v: 1, name: "A EXCH", region: "SEATTLE US", joshua: "period",
    world: 2, slot: "WOPR" }));
  const b = codeOf(sb.register(fakePort(), {
    t: "REGISTER", v: 1, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 2, slot: "PANAM" }));
  // A visitor dials A. openChannel is the ONLY way a visitor call arrives, and
  // it must never mark the channel as machine-originated.
  const visitorChan = sb.openChannel(a, fakePort(), "surface=home-terminal&session=S1");
  assert.equal(typeof visitorChan, "number");
  assert.equal(typeof sb.placeCall(a, { world: 2, slot: "PANAM" }, visitorChan as number), "object",
    "person -> machine -> machine is the whole point of the one-hop cap");
  assert.ok(b);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: the seeded tests FAIL — `sb.seededCode is not a function`. The depth test should already PASS (it pins existing behaviour); if it fails, stop and report, because that means `originated` is already wrong.

- [ ] **Step 3: Make seeds into exchanges**

In `src/trunk.ts`:

```typescript
interface Exchange {
  code: string; name: string; region: string; joshua: string; operator?: string;
  /** null until a seeded slot is given a port. A registrant always has one.
   *  Nullable rather than flagged so the compiler names every send site. */
  port: TrunkPort | null;
  /** A world-1 slot the hub seeds from its manifest rather than one a host
   *  registered. It is a real exchange — callable, and able to place — but it
   *  has no socket, is never swept, and prints its own directory shape. */
  seeded?: true;
  system?: string;
  world: number; slot: string;
  // ... rest unchanged
}
```

In the constructor, after `this.localWorld = checkLocalWorld(...)`:

```typescript
    // Seeds are exchanges from construction: `directory()` must be able to
    // print world 1 before the server has finished listening and can hand them
    // a port. `place()`'s occupancy check therefore needs no special case for
    // them, and neither does `register()`'s slot-taken rule.
    for (const seed of this.localWorld) {
      let code = newExchangeCode();
      while (this.exchanges.has(code)) code = newExchangeCode();
      this.exchanges.set(code, {
        code, name: seed.name, region: seed.region,
        joshua: seed.joshua ?? "period", operator: seed.operator,
        port: null, seeded: true, system: seed.system,
        world: 1, slot: seed.slot,
        channels: new Map(), nextChan: 1, originated: new Set(),
        pending: new Map(), nextRid: 1, missedPongs: 0,
      });
    }
```

Add the two methods:

```typescript
  /** The code the hub gave a seeded slot, for a caller that has only the name. */
  seededCode(slot: string): string | undefined {
    for (const ex of this.exchanges.values()) if (ex.seeded && ex.slot === slot) return ex.code;
    return undefined;
  }

  /** Give a seeded slot the port that answers its calls. Called once, at
   *  startup, when the server knows its own address. */
  seedPort(slot: string, port: TrunkPort): string | undefined {
    const code = this.seededCode(slot);
    if (code) this.exchanges.get(code)!.port = port;
    return code;
  }
```

- [ ] **Step 4: Collapse the two forks the seeds used to need**

In `place()`, delete the whole `if (this.localWorld.length > 0) { ... }` block —
`occ` is now built from `exchanges`, which contains the seeds.

In `register()`, replace the `maxExchanges` guard:

```typescript
    let registered = 0;
    for (const ex of this.exchanges.values()) if (!ex.seeded) registered += 1;
    if (registered >= this.maxExchanges) return "full";
```

and set `port` (a registrant always has one) and no `seeded` on the record it
creates — the existing literal already omits `seeded`; add nothing.

In `directory()`, delete the `byWorld.set(1, this.localWorld.map(...))` block and
make the exchange loop emit both shapes:

```typescript
    for (const ex of this.exchanges.values()) {
      let list = byWorld.get(ex.world);
      if (!list) byWorld.set(ex.world, (list = []));
      list.push(ex.seeded
        // No `/x/<CODE>` hop: there is no trunk to hop over, so a seed points
        // at the hub's public base and carries the bridge `system` id that
        // opens a session against it.
        ? { id: `local-${ex.slot.toLowerCase()}`, name: ex.name, region: ex.region,
            api: publicBase, link: `${wsBase}/link`,
            joshua: ex.joshua, operator: ex.operator, online: true as const,
            world: ex.world, slot: ex.slot, ...(ex.system ? { system: ex.system } : {}) }
        : { id: `trunk-${ex.code.toLowerCase()}`, name: ex.name, region: ex.region,
            api: `${publicBase}/x/${ex.code}`, link: `${wsBase}/x/${ex.code}/link`,
            joshua: ex.joshua, operator: ex.operator, online: true as const,
            world: ex.world, slot: ex.slot });
    }
```

In `sweepDead()`, skip seeds — a seeded slot is not a socket and cannot die:

```typescript
    for (const ex of this.exchanges.values()) {
      if (ex.seeded) continue;
      ex.missedPongs += 1;
      if (ex.missedPongs >= 2) dropped.push(ex.code);
      else ex.port?.send(JSON.stringify({ t: "PING" }));
    }
```

In `unregister()`, refuse to delete a seed:

```typescript
    const ex = this.exchanges.get(code);
    if (!ex || ex.seeded) return;
```

- [ ] **Step 5: Let the compiler find every send site**

Run: `cd emulator/relay && npm run typecheck`
Expected: errors on each `ex.port.send(...)` / `target.port.send(...)`. Fix each
by guarding rather than asserting:

- `openChannel`: after the `busy` check, `if (!ex.port) return "offline";`
- `placeCall`: after `if (!target) return "offline";`, add
  `if (!target.port || !from.port) return "offline";`
- `closeChannel`, `clientFrame`, `handleHostFrame`, `request`, `peerPort`: use
  `?.send(...)`.

A seeded slot with no port answers `offline` — which is true: nothing is
listening on it yet.

- [ ] **Step 6: Run the full relay suite**

Run: `cd emulator/relay && npm test`
Expected: all PASS, `tests/worlds.test.ts` included. `worlds.test.ts` asserts the
directory's seeded shape; if an assertion moved, the shape changed and that is a
regression, not a test to update — stop and report.

- [ ] **Step 7: Commit**

```bash
git add emulator/relay/src/trunk.ts emulator/relay/tests/trunk.test.ts
git commit -m "The flagship's own slots become real exchanges

World 1's seeds enter the exchange map with a nullable port, so they are
callable and can originate. Two forks collapse: directory() stops
synthesizing world 1 separately and place() stops hand-seeding
occupancy. Also pins the depth cap's real predicate — from a machine,
not carrying an origin — before piece B makes every OPEN carry one."
```

---

### Task 5: The hub's seeded port, and `POST /trunk/place`

**Files:**
- Modify: `emulator/relay/src/server.ts`
- Test: `emulator/relay/tests/server.test.ts`

**Interfaces:**
- Consumes: `openLocalLeg` (Task 1), `Switchboard.seedPort` / `seededCode` (Task 4).
- Produces: `POST /trunk/place` taking `{ slot, world?, seat?, on? }` and answering
  `201 { chan }` or `409 { refused: <RefusedReason> }`; `401` without the internal token.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/server.test.ts`:

```typescript
test("trunk/place: refuses without the internal token", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }));
    assert.equal(res.status, 401);
  } finally { await server.close(); }
});

test("trunk/place: answers the refusal reason rather than an error", async () => {
  const server = await startServer({ port: 0, internalToken: "SECRET",
    trunk: { localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "COLORADO US" }] } });
  try {
    const res = await httpJson("POST", `http://127.0.0.1:${server.port}/trunk/place`,
      JSON.stringify({ slot: "PANAM" }), { "x-wopr-internal-token": "SECRET" });
    assert.equal(res.status, 409);
    assert.deepEqual(JSON.parse(res.body), { refused: "offline" });
  } finally { await server.close(); }
});
```

Extend the file's `httpJson` helper to take an optional headers argument:

```typescript
function httpJson(method: string, url: string, body?: string,
                  headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/server.test.ts"`
Expected: FAIL — both get 404, the route does not exist.

- [ ] **Step 3: Build the seeded port**

In `src/server.ts`, after the `httpServer.listen` call that sets `port`, add:

```typescript
  /** A seeded world-1 slot's "host". It speaks the same TrunkFrame the
   *  switchboard sends down a real trunk socket, but instead of a socket it
   *  opens a local leg against the hub's own bridge. That is the whole trick:
   *  the flagship becomes callable without a trunk back to itself. */
  function seededPort(seed: LocalSlot, code: string): TrunkPort {
    const legs = new Map<number, LocalLeg>();
    const up = (f: TrunkFrame) => switchboard.handleHostFrame(code, f);
    return {
      send: (raw: string) => {
        let f: TrunkFrame;
        try { f = decodeTrunkFrame(raw); } catch { return; }
        if (f.t === "OPEN") {
          const o = f.origin;
          void openLocalLeg({
            // ServerOpts.bridgeUrl is a WEBSOCKET url (`ws://bridge:8000`,
            // server.ts:50) — it is what /link dials for /ws/session/<id>.
            // openLocalLeg mints over HTTP against the same host.
            bridgeUrl: bridgeUrl.replace(/^ws/, "http"),
            commsUrl: `ws://127.0.0.1:${port}`,
            surface: "trunk-call",
            system: seed.system,
            origin: o === undefined ? undefined
              : "seat" in o ? `seat ${o.seat}` : `world ${o.world} slot ${o.slot}`,
            send: (data) => up({ t: "FRAME", chan: f.chan, data }),
            close: (reason) => { legs.delete(f.chan); up({ t: "CLOSE", chan: f.chan, reason }); },
          }).then((leg) => { if (leg !== "refused") legs.set(f.chan, leg); });
        } else if (f.t === "FRAME") legs.get(f.chan)?.deliver(f.data);
        else if (f.t === "CLOSE") { legs.get(f.chan)?.close(); legs.delete(f.chan); }
        else if (f.t === "PING") up({ t: "PONG" });
        // The hub synthesizes a seed's directory entry itself, so nothing ever
        // needs to ask a seeded slot for REST. Answer honestly rather than hang.
        else if (f.t === "REQUEST") up({ t: "RESPONSE", rid: f.rid, status: 404, body: "{}" });
      },
      close: () => { for (const l of legs.values()) l.close(); legs.clear(); },
    };
  }

  for (const seed of trunkLocalWorld) {
    const code = switchboard.seededCode(seed.slot);
    if (code) switchboard.seedPort(seed.slot, seededPort(seed, code));
  }
```

`trunkLocalWorld` is whatever `startServer` already passes as
`trunk.localWorld` — bind it to a local `const` beside the `Switchboard`
construction if it is currently inlined.

Add the imports:

```typescript
import { openLocalLeg, type LocalLeg } from "./local-leg.ts";
import { decodeTrunkFrame, type LocalSlot, type TrunkFrame, type TrunkPort } from "./trunk.ts";
```

(some of these are already imported — merge rather than duplicate).

- [ ] **Step 4: Add the route**

In `handleHttp`, before the final 404:

```typescript
    // The seam between "a program wanted something" and "a call was placed".
    // A seeded slot has no trunk socket to send a PLACE down, so piece D's
    // node host reaches the switchboard through here instead.
    if (req.method === "POST" && url.pathname === "/trunk/place") {
      if (internalToken && req.headers["x-wopr-internal-token"] !== internalToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req);
      let want: { slot?: string; world?: number; seat?: string; on?: number };
      try { want = JSON.parse(body || "{}"); } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "malformed body" })); return;
      }
      const from = switchboard.seededCode("WOPR");
      if (!from) {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ refused: "offline" })); return;
      }
      const target = want.seat !== undefined
        ? { seat: want.seat }
        : { slot: want.slot ?? "", world: want.world };
      const r = switchboard.placeCall(from, target as CallTarget, want.on);
      if (typeof r === "string") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ refused: r }));
      } else {
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ chan: r.chan }));
      }
      return;
    }
```

Reuse the file's existing request-body reader; if there is none, add:

```typescript
  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    });
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/server.test.ts"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add emulator/relay/src/server.ts emulator/relay/tests/server.test.ts
git commit -m "The hub answers for its own seeded slots, and can be told to dial

A seeded slot's port opens a local leg against the hub's own bridge
instead of writing to a socket, so the flagship is callable without a
trunk back to itself. POST /trunk/place is the seam piece D will use
when Joshua forms an intention."
```

---

### Task 6: `seats.ts` — legs, handles, and the ring timer

**Files:**
- Create: `emulator/relay/src/seats.ts`
- Test: `emulator/relay/tests/seats.test.ts`

**Interfaces:**
- Consumes: `encodeEnvelope` from `./envelope.ts`.
- Produces:
  ```typescript
  export interface SeatPort { send(data: string): void; close(code?: number, reason?: string): void }
  export interface SeatLeg { id: string; surface: string; port: SeatPort; onCall: boolean }
  export interface RingHandlers { answered(): void; rejected(): void; timedOut(): void }

  export class SeatRegistry {
    constructor(opts?: {
      newId?: () => string;
      ringTimeoutMs?: number;                                    // default 30_000
      setTimer?: (ms: number, fn: () => void) => () => void;     // returns a cancel
    })
    open(port: SeatPort, surface: string): { id: string; token: string }
    close(id: string): void
    byToken(token: string): SeatLeg | undefined
    mint(token: string, code: string): string | undefined
    resolve(handle: string, code: string): SeatLeg | "seat-gone"
    ring(id: string, name: string, h: RingHandlers): "ringing" | "busy" | "seat-gone"
    answer(id: string): void
    reject(id: string): void
    release(id: string): void
  }
  ```

**Why this is its own module.** The capability rule — *PANAM's handle is refused when PROTOVISION presents it* — is the security-relevant part of this work. Here it is a unit test against a small object; inside `Switchboard` it would need a fixture built from two live trunk sockets, and nobody would write the negative cases.

- [ ] **Step 1: Write the failing tests**

Create `emulator/relay/tests/seats.test.ts`:

```typescript
// Seat legs, handles, and rings. A handle is a CAPABILITY, not an identifier:
// it is minted per (seat, exchange), disclosed only to the exchange that
// earned it by being called, and dies with the leg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SeatRegistry } from "../src/seats.ts";
import { decodeEnvelope } from "../src/envelope.ts";

function fakeSeat() {
  const sent: string[] = [];
  let closed = false;
  return {
    sent, get closed() { return closed; },
    send: (d: string) => sent.push(d),
    close: () => { closed = true; },
  };
}

/** Deterministic ids and a timer the test drives by hand. */
function registry() {
  let n = 0;
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const reg = new SeatRegistry({
    newId: () => `ID${++n}`,
    setTimer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
  });
  return { reg, timers, fire: () => { for (const t of timers) if (!t.cancelled) t.fn(); } };
}

test("seats: a leg is minted a token, and told it on connect", () => {
  const { reg } = registry();
  const port = fakeSeat();
  const { token } = reg.open(port, "home-terminal");
  const e = decodeEnvelope(port.sent[0]);
  assert.equal(e.kind, "control");
  assert.equal(e.payload, `SEAT ${token}`);
});

test("seats: a handle is minted on the first call and reused on the next", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  const first = reg.mint(token, "PANAM1");
  const second = reg.mint(token, "PANAM1");
  assert.equal(typeof first, "string");
  assert.equal(first, second, "one seat, one exchange, one handle");
});

test("seats: a second exchange gets a DIFFERENT handle for the same seat", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  assert.notEqual(reg.mint(token, "PANAM1"), reg.mint(token, "PROTO1"));
});

test("seats: one exchange's handle is refused when another presents it", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  const handle = reg.mint(token, "PANAM1")!;
  assert.notEqual(reg.resolve(handle, "PANAM1"), "seat-gone");
  assert.equal(reg.resolve(handle, "PROTO1"), "seat-gone",
    "a handle is scoped to the machine that earned it");
});

test("seats: an unknown handle is refused exactly like a stolen one", () => {
  const { reg } = registry();
  assert.equal(reg.resolve("NOSUCH", "PANAM1"), "seat-gone");
});

test("seats: every handle dies with the leg", () => {
  const { reg } = registry();
  const { id, token } = reg.open(fakeSeat(), "home-terminal");
  const handle = reg.mint(token, "PANAM1")!;
  reg.close(id);
  assert.equal(reg.resolve(handle, "PANAM1"), "seat-gone");
  assert.equal(reg.byToken(token), undefined);
});

test("seats: a ring reaches the seat, and an answer stops the timer", () => {
  const { reg, timers, fire } = registry();
  const port = fakeSeat();
  const { id } = reg.open(port, "home-terminal");
  const seen: string[] = [];
  assert.equal(reg.ring(id, "PAN AM", {
    answered: () => seen.push("answered"),
    rejected: () => seen.push("rejected"),
    timedOut: () => seen.push("timedOut"),
  }), "ringing");
  assert.equal(decodeEnvelope(port.sent.at(-1)!).payload, "RING PAN AM");
  reg.answer(id);
  assert.deepEqual(seen, ["answered"]);
  fire();
  assert.deepEqual(seen, ["answered"], "an answered ring must not also time out");
  assert.equal(timers[0].ms, 30_000);
});

test("seats: a reject and a timeout each fire once", () => {
  const { reg, fire } = registry();
  const a = reg.open(fakeSeat(), "home-terminal");
  const seenA: string[] = [];
  reg.ring(a.id, "PAN AM", { answered: () => {}, rejected: () => seenA.push("rejected"), timedOut: () => seenA.push("timedOut") });
  reg.reject(a.id);
  fire();
  assert.deepEqual(seenA, ["rejected"]);

  const b = reg.open(fakeSeat(), "home-terminal");
  const seenB: string[] = [];
  reg.ring(b.id, "PAN AM", { answered: () => {}, rejected: () => {}, timedOut: () => seenB.push("timedOut") });
  fire();
  assert.deepEqual(seenB, ["timedOut"]);
});

test("seats: a seat that is ringing or on a call is busy", () => {
  const { reg } = registry();
  const { id } = reg.open(fakeSeat(), "home-terminal");
  const noop = { answered: () => {}, rejected: () => {}, timedOut: () => {} };
  assert.equal(reg.ring(id, "PAN AM", noop), "ringing");
  assert.equal(reg.ring(id, "PROTOVISION", noop), "busy");
  reg.answer(id);
  assert.equal(reg.ring(id, "PROTOVISION", noop), "busy");
  reg.release(id);
  assert.equal(reg.ring(id, "PROTOVISION", noop), "ringing");
});

test("seats: ringing an unknown leg is seat-gone", () => {
  const { reg } = registry();
  assert.equal(reg.ring("NOPE", "PAN AM", { answered: () => {}, rejected: () => {}, timedOut: () => {} }), "seat-gone");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/seats.test.ts"`
Expected: FAIL — `Cannot find module '../src/seats.ts'`.

- [ ] **Step 3: Write `src/seats.ts`**

```typescript
// Seats: the visitor legs a machine can ring, and the handles that let it.
//
// A seat is a socket. While it is open the seat exists and can be rung; when it
// closes the seat is gone, and so is every handle minted for it. Nothing is
// stored, nothing is listed, and no machine can ring a person it has never
// spoken to.
//
// A HANDLE is a capability, not an identifier. It is minted per (seat,
// exchange) on the first call that seat places to that exchange, disclosed to
// that exchange alone, and useless anywhere else — PAN AM and PROTOVISION hold
// different handles for the same seat and neither can use the other's.
//
// A TOKEN is not a handle. It is the visitor's own name for their own leg,
// travels only to the terminal that owns it, resolves only inside this hub, and
// is never disclosed to any machine. The hub needs one because a terminal mints
// a fresh bridge session per dial, so nothing else correlates a dial to a seat.

import { encodeEnvelope } from "./envelope.ts";
import { TRUNK_ALPHABET } from "./trunk.ts";

export interface SeatPort { send(data: string): void; close(code?: number, reason?: string): void }
export interface SeatLeg { id: string; surface: string; port: SeatPort; onCall: boolean }
export interface RingHandlers { answered(): void; rejected(): void; timedOut(): void }

interface Leg extends SeatLeg {
  token: string;
  /** exchange code -> the handle that exchange holds for this seat. */
  handles: Map<string, string>;
  ring?: { h: RingHandlers; cancel: () => void };
}

function randomId(): string {
  let s = "";
  while (s.length < 22) s += TRUNK_ALPHABET[Math.floor(Math.random() * TRUNK_ALPHABET.length)];
  return s;
}

export class SeatRegistry {
  private legs = new Map<string, Leg>();
  private byTokenIdx = new Map<string, string>();
  /** handle -> { leg id, the ONE exchange code that may present it } */
  private handleIdx = new Map<string, { id: string; code: string }>();
  private newId: () => string;
  private ringTimeoutMs: number;
  private setTimer: (ms: number, fn: () => void) => () => void;

  constructor(opts: {
    newId?: () => string;
    ringTimeoutMs?: number;
    setTimer?: (ms: number, fn: () => void) => () => void;
  } = {}) {
    this.newId = opts.newId ?? randomId;
    this.ringTimeoutMs = opts.ringTimeoutMs ?? 30_000;
    this.setTimer = opts.setTimer ?? ((ms, fn) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  }

  open(port: SeatPort, surface: string): { id: string; token: string } {
    const id = this.newId();
    const token = this.newId();
    this.legs.set(id, { id, surface, port, onCall: false, token, handles: new Map() });
    this.byTokenIdx.set(token, id);
    this.envelope(id, `SEAT ${token}`);
    return { id, token };
  }

  close(id: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.ring?.cancel();
    for (const handle of leg.handles.values()) this.handleIdx.delete(handle);
    this.byTokenIdx.delete(leg.token);
    this.legs.delete(id);
  }

  byToken(token: string): SeatLeg | undefined {
    const id = this.byTokenIdx.get(token);
    return id === undefined ? undefined : this.legs.get(id);
  }

  mint(token: string, code: string): string | undefined {
    const id = this.byTokenIdx.get(token);
    const leg = id === undefined ? undefined : this.legs.get(id);
    if (!leg) return undefined;
    const existing = leg.handles.get(code);
    if (existing !== undefined) return existing;
    const handle = this.newId();
    leg.handles.set(code, handle);
    this.handleIdx.set(handle, { id: leg.id, code });
    return handle;
  }

  /** A handle presented by an exchange that did not earn it is refused exactly
   *  as an unknown one is. A machine learns nothing about seats it has not
   *  spoken to — not that they exist, not that they are online. */
  resolve(handle: string, code: string): SeatLeg | "seat-gone" {
    const entry = this.handleIdx.get(handle);
    if (!entry || entry.code !== code) return "seat-gone";
    return this.legs.get(entry.id) ?? "seat-gone";
  }

  ring(id: string, name: string, h: RingHandlers): "ringing" | "busy" | "seat-gone" {
    const leg = this.legs.get(id);
    if (!leg) return "seat-gone";
    if (leg.ring || leg.onCall) return "busy";
    const cancel = this.setTimer(this.ringTimeoutMs, () => {
      if (leg.ring?.h !== h) return;
      leg.ring = undefined;
      h.timedOut();
    });
    leg.ring = { h, cancel };
    this.envelope(id, `RING ${name}`);
    return "ringing";
  }

  answer(id: string): void {
    const leg = this.legs.get(id);
    const ring = leg?.ring;
    if (!leg || !ring) return;
    ring.cancel();
    leg.ring = undefined;
    leg.onCall = true;
    ring.h.answered();
  }

  reject(id: string): void {
    const leg = this.legs.get(id);
    const ring = leg?.ring;
    if (!leg || !ring) return;
    ring.cancel();
    leg.ring = undefined;
    ring.h.rejected();
  }

  /** The call this seat was on has ended; it can be rung again. */
  release(id: string): void {
    const leg = this.legs.get(id);
    if (leg) leg.onCall = false;
  }

  private envelope(id: string, payload: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.port.send(encodeEnvelope({
      v: 1, session: id, seq: 0, kind: "control", link: "seat", payload, eom: true,
    }));
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/seats.test.ts"`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add emulator/relay/src/seats.ts emulator/relay/tests/seats.test.ts
git commit -m "Seat legs, and handles that are capabilities

A handle is minted per (seat, exchange), disclosed only to the exchange
that earned it by being called, and dies with the leg. A handle another
exchange presents is refused exactly as an unknown one is, so a machine
learns nothing about seats it has not spoken to."
```

---

### Task 7: `/seat`, and the token that must not cross the trunk

**Files:**
- Modify: `emulator/relay/src/server.ts` (the upgrade router, a new `seatWss`, `relayWss`'s query)
- Test: `emulator/relay/tests/server.test.ts`

**Interfaces:**
- Consumes: `SeatRegistry` (Task 6).
- Produces: the `/seat?surface=<name>` endpoint; `startServer` accepts
  `seats?: { ringTimeoutMs?: number; newId?: () => string }` so tests can be
  deterministic.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/server.test.ts`:

```typescript
test("seat: a leg is told its token on connect", async () => {
  const server = await startServer({ port: 0 });
  try {
    const ws = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    const e = decodeEnvelope(await nextMessage(ws));
    assert.equal(e.kind, "control");
    assert.match(e.payload, /^SEAT \S+$/);
    ws.close();
  } finally { await server.close(); }
});

test("seat: an unknown surface is refused", async () => {
  const server = await startServer({ port: 0 });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/seat?surface=nope`);
    const code = await new Promise<number>((resolve) => ws.once("close", resolve));
    assert.equal(code, 4400);
  } finally { await server.close(); }
});

test("seat: the token never crosses the trunk", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hub = `ws://127.0.0.1:${server.port}/trunk`;
  const host = await connect(hub);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "A EXCH",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));
    assert.equal(assigned.t, "ASSIGNED");

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const visitor = new WebSocket(
      `ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    const open = JSON.parse(await nextMessage(host));
    assert.equal(open.t, "OPEN");
    assert.doesNotMatch(open.query, /seat=/,
      "the seat token is the one credential a foreign host must never see");
    assert.ok(!JSON.stringify(open).includes(token), "nor anywhere else in the frame");
    visitor.close(); seat.close();
  } finally { host.close(); await server.close(); }
});
```

Ensure `tests/server.test.ts` imports `decodeEnvelope` from `../src/envelope.ts`
and has the `connect` / `nextMessage` helpers (copy them from
`tests/tieline.test.ts:16-29` if absent).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/server.test.ts"`
Expected: FAIL — `/seat` is not routed (the socket is destroyed), and the `OPEN`
query still carries `seat=`.

- [ ] **Step 3: Route and serve `/seat`**

In `src/server.ts`, beside the other `WebSocketServer`s:

```typescript
  const seatWss = new WebSocketServer({ noServer: true, maxPayload: TRUNK_MAX_FRAME_BYTES });
  const seats = new SeatRegistry({
    ringTimeoutMs: opts.seats?.ringTimeoutMs,
    newId: opts.seats?.newId,
  });
```

Add `/seat` to the upgrade router:

```typescript
    const target = path === "/link" ? linkWss
      : path === "/trunk" ? trunkWss
      : path === "/seat" ? seatWss
      : /^\/x\/[A-Z2-9]{6}\/link$/.test(path) ? relayWss
      : null;
```

And the connection handler:

```typescript
  // The second visitor leg. A terminal opens it when it starts and holds it for
  // the life of the session: while this socket is open the seat exists and can
  // be rung, and when it closes the seat is gone. Calls still run over /link
  // and /x/<CODE>/link — this leg carries rings, not conversations.
  seatWss.on("connection", (client, req) => {
    const url = new URL(req.url ?? "/seat", "http://comms.invalid");
    const surface = url.searchParams.get("surface") ?? "";
    // The surface decides the profile an answered ring is paced at, so a seat
    // without a resolvable one could be rung but never heard.
    if (!resolveLink(config, surface)) { client.close(4400, "unknown surface"); return; }
    if (seats.size >= (opts.seats?.maxSeats ?? 512)) { client.close(4429, "too many seats"); return; }

    const { id } = seats.open(
      { send: (d) => { if (client.readyState === WebSocket.OPEN) client.send(d); },
        close: (code, reason) => client.close(code, reason) },
      surface);

    const seatPing = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, opts.trunk?.relayPingMs ?? 30_000);

    client.on("message", (data) => {
      let e: Envelope;
      try { e = decodeEnvelope(data.toString()); } catch { return; }
      if (e.kind !== "control") return;
      if (e.payload === "ANSWER") seats.answer(id);
      else if (e.payload === "REJECT") seats.reject(id);
    });
    const drop = () => { clearInterval(seatPing); seats.close(id); };
    client.on("close", drop);
    client.on("error", drop);
  });
```

Add `size` to `SeatRegistry` in `src/seats.ts`:

```typescript
  get size(): number { return this.legs.size; }
```

and `seats?: { ringTimeoutMs?: number; newId?: () => string; maxSeats?: number }` to
`startServer`'s options type.

- [ ] **Step 4: Strip the token before it crosses the trunk**

In `relayWss.on("connection")`, replace the `openChannel` call:

```typescript
    const url = new URL(req.url ?? "/", "http://comms.invalid");
    const code = url.pathname.split("/")[2];
    // The seat token names the visitor's own leg and resolves only inside this
    // hub. It must NEVER reach a host: openChannel forwards this query verbatim
    // in the OPEN, and the callee's tieline pastes it straight into its own
    // /link. Left in, every foreign exchange would be handed the token of every
    // visitor who dialled it — the one credential the whole handle design
    // exists to keep away from machines.
    const params = new URLSearchParams(url.search);
    const seatToken = params.get("seat");
    params.delete("seat");
    const chan = switchboard.openChannel(code, client, params.toString());
```

Keep `seatToken` in scope — Task 8 uses it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd emulator/relay && node --test --test-force-exit "tests/server.test.ts"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add emulator/relay/src/server.ts emulator/relay/src/seats.ts emulator/relay/tests/server.test.ts
git commit -m "A seat is a socket, and its token stops at the hub

/seat is the leg a terminal holds for the life of its session: while it
is open the seat can be rung. The token it is given names the visitor's
own leg and is stripped from every query before an OPEN carries it —
without that, every foreign host is handed every visitor's credential."
```

---

### Task 8: A dial that carries a token earns a handle

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (`openChannel` takes an origin), `emulator/relay/src/seats.ts` (`hold`, `leg`), `emulator/relay/src/server.ts` (`relayWss`, `linkWss`)
- Test: `emulator/relay/tests/server.test.ts`

**Interfaces:**
- Consumes: `SeatRegistry.mint` (Task 6), the `seatToken` local from Task 7.
- Produces: `openChannel(code, client, query, origin?: CallOrigin): number | "offline" | "busy" | "oversize"`;
  `SeatRegistry.hold(id)`, `SeatRegistry.leg(id): SeatLeg | undefined`.

**A documented limit.** All seeded entries share `link: <wsBase>/link`, and the
slot a direct dial reached is carried in the *session* the terminal minted with
the bridge, which the hub never sees. So a direct `/link` dial mints its handle
for the hub's own Joshua line (`WOPR`), configurable as `opts.seats.homeSlot`. A
seeded period system dialled directly earns no handle — it has no reason to ring
anyone back, and piece D is Joshua's beat alone.

- [ ] **Step 1: Write the failing test**

Append to `emulator/relay/tests/server.test.ts`:

```typescript
test("seat: a dial carrying a token discloses a handle to the exchange it called", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    const first = new WebSocket(`ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    const open1 = JSON.parse(await nextMessage(host));
    assert.ok(open1.origin && typeof open1.origin.seat === "string",
      "a machine learns who called by being called");
    first.close();

    const second = new WebSocket(`ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S2&token=T2&seat=${token}`);
    const open2 = JSON.parse(await nextMessage(host));
    assert.equal(open2.origin.seat, open1.origin.seat,
      "one seat, one exchange, one handle — across calls");
    second.close(); seat.close();
  } finally { host.close(); await server.close(); }
});

test("seat: a dial without a token discloses nothing", async () => {
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));
    const visitor = new WebSocket(`ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1`);
    const open = JSON.parse(await nextMessage(host));
    assert.equal(open.origin, undefined, "a stale tab still gets to phone a machine");
    visitor.close();
  } finally { host.close(); await server.close(); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/server.test.ts"`
Expected: the first test FAILS — the `OPEN` has no `origin`.

- [ ] **Step 3: Let `openChannel` carry an origin**

In `src/trunk.ts`:

```typescript
  openChannel(code: string, client: ChannelPort, query: string,
              origin?: CallOrigin): number | "offline" | "busy" | "oversize" {
    const ex = this.exchanges.get(code);
    if (!ex) return "offline";
    if (!ex.port) return "offline";
    if (ex.channels.size >= this.maxChannels) return "busy";
    const chan = ex.nextChan;
    const encoded = JSON.stringify({ t: "OPEN", chan, query, ...(origin ? { origin } : {}) });
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) return "oversize";
    ex.nextChan += 1;
    ex.channels.set(chan, client);
    // NOT `originated`. That set means "arrived from a machine" and gates the
    // one-hop cap; a person's call must leave a machine free to call onward.
    ex.port.send(encoded);
    return chan;
  }
```

- [ ] **Step 4: Add the two small registry helpers**

In `src/seats.ts`:

```typescript
  leg(id: string): SeatLeg | undefined { return this.legs.get(id); }

  /** This seat is on a call — a dialled one, not only an answered ring — so it
   *  is busy to anyone trying to ring it. */
  hold(id: string): void { const leg = this.legs.get(id); if (leg) leg.onCall = true; }
```

- [ ] **Step 5: Mint on the relayed dial**

In `relayWss.on("connection")`, using the `seatToken` from Task 7:

```typescript
    const handle = seatToken === null ? undefined : seats.mint(seatToken, code);
    const chan = switchboard.openChannel(code, client, params.toString(),
                                         handle ? { seat: handle } : undefined);
```

and in `cleanup`, release the seat if one was held:

```typescript
    const seatId = seatToken === null ? undefined : seats.byToken(seatToken)?.id;
    if (seatId) seats.hold(seatId);
    const cleanup = () => {
      clearInterval(relayPing);
      if (seatId) seats.release(seatId);
      switchboard.closeChannel(code, chan);
    };
```

- [ ] **Step 6: Mint on the direct dial**

In `linkWss.on("connection")`, after `resolveLink` succeeds:

```typescript
    // A direct dial reaches the hub's own bridge, and which seeded slot it
    // reached rides in the session the terminal minted — which this leg never
    // sees. So the handle is minted for the hub's own Joshua line: the only
    // seeded slot with a reason to ring anyone back.
    const seatToken = url.searchParams.get("seat");
    const homeCode = switchboard.seededCode(opts.seats?.homeSlot ?? "WOPR");
    const seatLeg = seatToken ? seats.byToken(seatToken) : undefined;
    const handle = seatToken && homeCode ? seats.mint(seatToken, homeCode) : undefined;
    if (seatLeg) seats.hold(seatLeg.id);
```

and in `teardown`, `if (seatLeg) seats.release(seatLeg.id);`.

Then disclose it to the program, on the same uniform rule as every other path —
push it into `upstreamBuffer` before `dial()` runs, so it is the first thing the
bridge receives:

```typescript
    if (handle) {
      upstreamBuffer.push({ v: 1, session, seq: 0, kind: "control",
                            link: linkName, payload: `ORIGIN seat ${handle}`, eom: true });
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd emulator/relay && npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add emulator/relay/src/trunk.ts emulator/relay/src/seats.ts emulator/relay/src/server.ts emulator/relay/tests/server.test.ts
git commit -m "A machine learns a seat's handle by being called from it

A dial carrying a seat token mints a handle for the exchange it reached
and discloses it as the call's origin — on the OPEN across a trunk, as
an ORIGIN control envelope for the hub's own line. A dial without a
token discloses nothing, so a stale tab can still phone a machine."
```

---

### Task 9: Ringing

**Files:**
- Modify: `emulator/relay/src/trunk.ts` (`placeCall`'s seat branch, `SwitchboardOpts`), `emulator/relay/src/server.ts` (the `SeatBridge`)
- Test: `emulator/relay/tests/trunk.test.ts`, `emulator/relay/tests/server.test.ts`

**Interfaces:**
- Consumes: `SeatRegistry` (Task 6), `LinkShaper` from `./shaper.ts`.
- Produces:
  ```typescript
  export interface SeatBridge {
    resolve(handle: string, code: string): { id: string } | "seat-gone";
    /** Ring, and hand back the port the caller's channel writes into. Frames
     *  written before the seat answers are HELD, not dropped: the calling
     *  program greets the moment it connects, and those are its first words. */
    ring(id: string, callerName: string,
         wire: { toMachine: (data: string) => void; onEnd: (reason: string) => void })
      : ChannelPort | "busy" | "seat-gone";
  }
  // SwitchboardOpts gains: seats?: SeatBridge
  ```

- [ ] **Step 1: Write the failing tests**

Append to `emulator/relay/tests/trunk.test.ts`:

```typescript
test("ring: a PLACE to a seat is refused when there is no seat bridge", () => {
  const sb = new Switchboard({ reservedWorlds: [] });
  const a = codeOf(sb.register(fakePort(), { t: "REGISTER", v: 1, name: "A EXCH",
    region: "SEATTLE US", joshua: "period", world: 2, slot: "WOPR" }));
  assert.equal(sb.placeCall(a, { seat: "HDL1" }), "seat-gone");
});

test("ring: a PLACE to a live handle rings, and holds the caller's first words", () => {
  const rung: string[] = [];
  const toSeat: string[] = [];
  let answer: (() => void) | undefined;
  const sb = new Switchboard({
    reservedWorlds: [],
    seats: {
      resolve: (handle, code) => (handle === "HDL1" && code !== "") ? { id: "SEAT1" } : "seat-gone",
      ring: (id, callerName, wire) => {
        rung.push(`${id}:${callerName}`);
        let answered = false;
        const held: string[] = [];
        answer = () => { answered = true; toSeat.push(...held.splice(0)); };
        void wire;
        return {
          send: (d: string) => { if (answered) toSeat.push(d); else held.push(d); },
          close: () => {},
        };
      },
    },
  });
  const a = codeOf(sb.register(fakePort(), { t: "REGISTER", v: 1, name: "PAN AM",
    region: "SEATTLE US", joshua: "period", world: 2, slot: "PANAM" }));
  const placed = sb.placeCall(a, { seat: "HDL1" });
  assert.equal(typeof placed, "object");
  assert.deepEqual(rung, ["SEAT1:PAN AM"]);

  // The calling program greets the instant it connects — before anyone answers.
  sb.handleHostFrame(a, { t: "FRAME", chan: (placed as { chan: number }).chan, data: "GREETINGS" });
  assert.deepEqual(toSeat, [], "nothing crosses an unanswered line");
  answer!();
  assert.deepEqual(toSeat, ["GREETINGS"], "and the first words are not lost");
});

test("ring: a stolen handle is refused exactly as an unknown one", () => {
  const sb = new Switchboard({
    reservedWorlds: [],
    seats: { resolve: () => "seat-gone", ring: () => "seat-gone" },
  });
  const a = codeOf(sb.register(fakePort(), { t: "REGISTER", v: 1, name: "A EXCH",
    region: "SEATTLE US", joshua: "period", world: 2, slot: "WOPR" }));
  assert.equal(sb.placeCall(a, { seat: "SOMEONE-ELSES" }), "seat-gone");
});

test("ring: a busy seat is busy", () => {
  const sb = new Switchboard({
    reservedWorlds: [],
    seats: { resolve: () => ({ id: "SEAT1" }), ring: () => "busy" },
  });
  const a = codeOf(sb.register(fakePort(), { t: "REGISTER", v: 1, name: "A EXCH",
    region: "SEATTLE US", joshua: "period", world: 2, slot: "WOPR" }));
  assert.equal(sb.placeCall(a, { seat: "HDL1" }), "busy");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk.test.ts"`
Expected: the ring tests FAIL — `placeCall` returns a hardcoded `seat-gone`.

- [ ] **Step 3: Implement the seat branch**

In `src/trunk.ts`, `export` the `SeatBridge` interface beside `ChannelPort`
(the server imports it), add `seats?: SeatBridge` to the `Switchboard`
constructor's options and `private seats?: SeatBridge` to the
class, then replace the placeholder in `placeCall`:

```typescript
    // Piece B: a seat is the far end of a machine call too. The handle is a
    // capability the caller earned by being called from that seat — resolve
    // refuses one another exchange holds exactly as it refuses an unknown one,
    // so a machine learns nothing about seats it has not spoken to.
    if ("seat" in to) {
      if (!this.seats) return "seat-gone";
      const leg = this.seats.resolve(to.seat, from.code);
      if (leg === "seat-gone") return "seat-gone";
      if (from.channels.size >= this.maxChannels) return "busy";
      const callerChan = from.nextChan;
      const port = this.seats.ring(leg.id, from.name, {
        toMachine: (data) => this.clientFrame(from.code, callerChan, data),
        onEnd: (reason) => {
          if (from.channels.delete(callerChan)) {
            from.port?.send(JSON.stringify({ t: "CLOSE", chan: callerChan, reason }));
          }
        },
      });
      if (port === "busy" || port === "seat-gone") return port;
      from.nextChan += 1;
      from.channels.set(callerChan, port);
      return { chan: callerChan };
    }
```

Delete the old `if ("seat" in to) return "seat-gone";` line and its comment.

- [ ] **Step 4: Build the real `SeatBridge` in the server**

In `src/server.ts`, before the `Switchboard` construction:

```typescript
  // The seat's side of a ring: the hub paces it, because the ANSWERING end
  // paces. A machine's own leg does not shape (its surface is trunk-caller,
  // baud 0), so this is the one shaper in a machine -> seat call.
  const seatBridge: SeatBridge = {
    resolve: (handle, code) => {
      const leg = seats.resolve(handle, code);
      return leg === "seat-gone" ? "seat-gone" : { id: leg.id };
    },
    ring: (id, callerName, wire) => {
      const leg = seats.leg(id);
      if (!leg) return "seat-gone";
      const link = resolveLink(config, leg.surface);
      if (!link) return "seat-gone";
      const down = new LinkShaper(link.profile, link.name, id,
        (e: Envelope) => leg.port.send(encodeEnvelope(e)));
      const held: string[] = [];
      let answered = false;
      const push = (raw: string) => {
        try {
          const e = decodeEnvelope(raw);
          down.send({ kind: e.kind, payload: e.payload, eom: e.eom });
        } catch { /* not an envelope; the hub never inspects further */ }
      };
      const outcome = seats.ring(id, callerName, {
        answered: () => {
          answered = true;
          seats.attach(id, wire.toMachine);
          for (const d of held.splice(0)) push(d);
        },
        rejected: () => { down.close(); wire.onEnd("rejected"); },
        timedOut: () => { down.close(); wire.onEnd("no answer"); },
      });
      if (outcome !== "ringing") return outcome;
      return {
        send: (data: string) => { if (answered) push(data); else held.push(data); },
        close: (_code?: number, reason?: string) => {
          down.close(); seats.detach(id); seats.release(id);
          wire.onEnd(reason ?? "call ended");
        },
      };
    },
  };
```

Pass `seats: seatBridge` in the `new Switchboard({ ... })` options.

Add to `src/seats.ts` the two methods the bridge needs, so `/seat`'s message
handler can reach the machine during a call:

```typescript
  /** Route this seat's non-control envelopes to the machine it is talking to. */
  attach(id: string, toMachine: (data: string) => void): void {
    const leg = this.legs.get(id);
    if (leg) leg.inbound = toMachine;
  }
  detach(id: string): void {
    const leg = this.legs.get(id);
    if (leg) leg.inbound = undefined;
  }
  inboundOf(id: string): ((data: string) => void) | undefined {
    return this.legs.get(id)?.inbound;
  }
```

with `inbound?: (data: string) => void` on the private `Leg` interface.

Finally, extend `/seat`'s message handler (Task 7) so a seat on a call can speak:

```typescript
      if (e.kind === "control" && e.payload === "ANSWER") { seats.answer(id); return; }
      if (e.kind === "control" && e.payload === "REJECT") { seats.reject(id); return; }
      seats.inboundOf(id)?.(data.toString());
```

- [ ] **Step 5: Write the server-level ring test**

Append to `emulator/relay/tests/server.test.ts`:

```typescript
test("ring: a machine rings a seat that called it, and the seat answers", async () => {
  const server = await startServer({ port: 0,
    config: { ...DEFAULT_CONFIG, mode: "fast" }, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));

    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];

    // The seat calls PAN AM, which is how PAN AM earns a handle for it.
    const dial = new WebSocket(`ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    const open = JSON.parse(await nextMessage(host));
    const handle = open.origin.seat;
    dial.close();
    await new Promise((r) => setTimeout(r, 50));

    // Now PAN AM calls back.
    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    const placed = JSON.parse(await nextMessage(host));
    assert.equal(placed.t, "PLACED");
    const ring = decodeEnvelope(await nextMessage(seat));
    assert.equal(ring.payload, "RING PAN AM");

    seat.send(encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "control",
      link: "seat", payload: "ANSWER", eom: true }));
    host.send(JSON.stringify({ t: "FRAME", chan: placed.chan,
      data: encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "output",
        link: "trunk-caller", payload: "GREETINGS PROFESSOR FALKEN", eom: true }) }));
    const heard = decodeEnvelope(await nextMessage(seat));
    assert.equal(heard.payload, "GREETINGS PROFESSOR FALKEN");
    seat.close();
  } finally { host.close(); await server.close(); }
});

test("ring: a rejected ring closes the caller's channel", async () => {
  const server = await startServer({ port: 0,
    config: { ...DEFAULT_CONFIG, mode: "fast" }, trunk: { reservedWorlds: [] } });
  const host = await connect(`ws://127.0.0.1:${server.port}/trunk`);
  try {
    host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PAN AM",
      region: "SEATTLE US", joshua: "period", world: 1, slot: "PANAM" }));
    const assigned = JSON.parse(await nextMessage(host));
    const seat = await connect(`ws://127.0.0.1:${server.port}/seat?surface=home-terminal`);
    const token = decodeEnvelope(await nextMessage(seat)).payload.split(" ")[1];
    const dial = new WebSocket(`ws://127.0.0.1:${server.port}/x/${assigned.exchange}/link` +
      `?surface=home-terminal&session=S1&token=T1&seat=${token}`);
    const handle = JSON.parse(await nextMessage(host)).origin.seat;
    dial.close();
    await new Promise((r) => setTimeout(r, 50));

    host.send(JSON.stringify({ t: "PLACE", call: 1, to: { seat: handle } }));
    JSON.parse(await nextMessage(host));            // PLACED
    await nextMessage(seat);                        // RING
    seat.send(encodeEnvelope({ v: 1, session: "x", seq: 0, kind: "control",
      link: "seat", payload: "REJECT", eom: true }));
    const closed = JSON.parse(await nextMessage(host));
    assert.equal(closed.t, "CLOSE");
    assert.equal(closed.reason, "rejected");
    seat.close();
  } finally { host.close(); await server.close(); }
});
```

`ServerOpts` has no `comms` field — the option is `config` (`server.ts:23`),
so import `DEFAULT_CONFIG` from `../src/config.ts` in the test file. Fast mode
collapses the handshake to an instant CONNECTED and stops the shaper pacing, so
these two tests do not wait 30 seconds for 1200-baud playout.

- [ ] **Step 6: Run the full suite**

Run: `cd emulator/relay && npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add emulator/relay/src emulator/relay/tests
git commit -m "A machine can ring a seat, and the seat can answer or not

placeCall's seat branch rings through a SeatBridge the server supplies,
so trunk.ts stays free of link config. The caller's first words are held
rather than dropped while the line rings — a calling program greets the
moment it connects, and those are its first words. Reject closes at
once; an unanswered ring gives up after thirty seconds."
```

---

### Task 10: The end-to-end call piece A could not write

**Files:**
- Modify: `emulator/relay/tests/trunk-e2e.test.ts`
- Test: same file

**Interfaces:**
- Consumes: everything above.
- Produces: nothing — this is the proof.

**Why it matters.** The phase 2 design's Testing line for piece A asks for
"frames crossing both ways, and a clean close". Piece A could not write it: there
was no host-side endpoint at either end. This test is what closes
[real-wopr-programs#67](https://github.com/DanielLandi/real-wopr-programs/issues/67).

- [ ] **Step 1: Write the failing test**

Append to `emulator/relay/tests/trunk-e2e.test.ts`:

```typescript
test("e2e: a machine calls a machine, words cross both ways, and the line drops clean",
  { timeout: 15_000 }, async () => {
  const hubServer = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const hubUrl = `ws://127.0.0.1:${hubServer.port}/trunk`;

  // Each exchange is a full stack: its own bridge and its own comms relay.
  const bridgeA = await startStubBridge();
  const bridgeB = await startStubBridge();
  // startServer's bridgeUrl is a ws:// url; the tieline's localBridge is http://.
  const commsA = await startServer({ port: 0, bridgeUrl: `ws://127.0.0.1:${bridgeA.port}` });
  const commsB = await startServer({ port: 0, bridgeUrl: `ws://127.0.0.1:${bridgeB.port}` });

  const closesA: Array<{ chan: number; reason?: string }> = [];
  const a = startTieline({ hubUrl, name: "A EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "WOPR",
    localComms: `ws://127.0.0.1:${commsA.port}`, localBridge: `http://127.0.0.1:${bridgeA.port}`,
    onClose: (chan, reason) => closesA.push({ chan, reason }) });
  const b = startTieline({ hubUrl, name: "B EXCH", region: "SEATTLE US", joshua: "period",
    world: 1, slot: "PANAM",
    localComms: `ws://127.0.0.1:${commsB.port}`, localBridge: `http://127.0.0.1:${bridgeB.port}` });

  try {
    const deadline = Date.now() + 8000;
    while ((!a.assigned() || !b.assigned()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(a.assigned() && b.assigned());

    const placed = await a.place({ world: 1, slot: "PANAM" });
    assert.equal(typeof placed, "object", `A could not call B: ${JSON.stringify(placed)}`);
    const call = placed as { chan: number; close: (r?: string) => void };

    // Both ends minted a session of their own: the placer's program and the
    // answerer's program are what talk.
    while ((bridgeA.sessionPosts.length === 0 || bridgeB.sessionPosts.length === 0)
           && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(bridgeA.sessionPosts.length, 1, "the placer needs an end of its own");
    assert.equal(bridgeB.sessionPosts.length, 1, "the callee needs an end of its own");
    assert.match(bridgeA.sessionPosts[0], /"surface":"trunk-caller"/);
    assert.match(bridgeB.sessionPosts[0], /"surface":"trunk-call"/);

    // B's program was told who called, on the uniform rule.
    while (bridgeB.connections.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    while (bridgeB.connections[0].received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const first = decodeEnvelope(bridgeB.connections[0].received[0]);
    assert.equal(first.payload, "ORIGIN world 1 slot WOPR");

    // Words cross: the stub bridge echoes, so A's program hears B's program.
    while (bridgeA.connections.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const heardByA = () => bridgeA.connections[0].received
      .map((r) => decodeEnvelope(r).payload).join("");
    while (!heardByA().includes("ECHO") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(heardByA(), /ECHO/, "B's answer must reach A's program");

    // And a clean close, seen at both ends.
    call.close("done");
    while (closesA.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(closesA.length, 1);
  } finally {
    a.stop(); b.stop();
    await commsA.close(); await commsB.close();
    await bridgeA.close(); await bridgeB.close();
    await hubServer.close();
  }
});
```

- [ ] **Step 2: Run it and iterate until it passes**

Run: `cd emulator/relay && node --test --test-force-exit "tests/trunk-e2e.test.ts"`

This is the integration test: a failure here is a real defect in Tasks 1-9, not a
test to relax. Debug against the actual frames — add a temporary
`console.error` in `seededPort`/`openLocalLeg` if needed, and remove it before
committing. Do **not** widen an assertion to make it pass.

- [ ] **Step 3: Delete the stale comments #67 left behind**

- `src/trunk.ts` — the `placeCall` comment block ending "See issue #67."
  (the `query: ""` paragraph): rewrite to describe what now happens.
- `tests/trunk-e2e.test.ts` — the header comment that says frames crossing both
  ways are piece D's.
- `src/tieline.ts` — already done in Task 3.

Run: `cd emulator/relay && grep -rn "#67" src tests`
Expected: no matches.

- [ ] **Step 4: Run everything the CI gates**

```bash
cd emulator/relay && npm test && npm run typecheck
cd ../.. && make test && tools/behavior.sh
```

Expected: all PASS. The golden fixtures are untouched by this work — a fixture
diff here means something leaked out of the relay and must be understood, not
regenerated.

- [ ] **Step 5: Commit and open the PR**

```bash
git add emulator/relay
git commit -m "Machine calls carry words, both ways, and drop clean

Two real tielines, each with its own bridge and comms relay, one calling
the other: both mint an end of their own, the callee is told who called,
words cross in both directions and the line drops cleanly. This is the
phase 2 design's Testing line for piece A, unimplementable until the
ends existed.

Closes #67"

git push -u origin claude/machine-call-endpoints
gh pr create --title "Machine calls that carry words, and a seat that can be rung" --body "$(cat <<'BODY'
Worlds phase 2 pieces A' and B. Closes #67.

Piece A built the wire for machine-originated calls correctly and could
not build the thing at either end of one: a PLACE resolved to an integer
the placing host could not write to or hang up, and the callee was
dialled with an empty query its own /link refused. The call was real;
nothing crossed it.

Each end now attaches to whatever that end already is. A program
attaches through an ordinary bridge session dialled over its own /link
(`local-leg.ts`, used by both tielines and by the hub's seeded slots), so
a machine answering a machine runs the code path that answers a person.
A seat attaches through the socket the visitor already holds (`/seat`),
and a machine can ring one it has already been called from.

- World 1's seeded slots become real exchanges, so the flagship can
  place and receive calls. Two forks collapse: `directory()` stops
  synthesizing world 1 and `place()` stops hand-seeding occupancy.
- A handle is a capability minted per (seat, exchange), disclosed only
  to the exchange that earned it, dead when the leg closes. One
  exchange's handle presented by another is refused exactly as an
  unknown one is.
- The seat token is stripped from every query before an OPEN carries it.
  Without that, every foreign host is handed every visitor's credential.

Spec: real-wopr `docs/superpowers/specs/2026-08-27-machine-call-endpoints-design.md`
Plan: `docs/superpowers/plans/2026-08-27-machine-call-endpoints.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Wait for the nine required checks (`programs`, `node`, `relay`, `web`, `devkit`,
`images`, `terminal`, `federation`, `cli`), then `gh pr merge --squash`.

---

## After the merge

1. Re-pin `packs.lock` in `../real-wopr` to the squashed commit and re-run the evals (14/14).
2. Deploy **the hub before any host** — `/seat` and `POST /trunk/place` are new hub endpoints, and a host expecting them against an older relay gets a decode failure, not a graceful refusal. `homelab/apps/wopr/GO-LIVE.md` documents the order.
3. Pieces C (seat roles) and D (Joshua's intention) are now unblocked.
