// The host side of TRUNK/1 (trunk-federation spec): one outbound socket to
// the hub, one local WebSocket per relayed call, an allowlisted local REST
// relay. Runs next to a normal local stack; the hub can only ever reach the
// two configured local endpoints.

import { WebSocket } from "ws";
import {
  ALL_SLOTS, decodeTrunkFrame, restAllowed, type CallOrigin, type CallTarget,
  type RefusedReason, type TrunkFrame,
} from "./trunk.ts";
import { openLocalLeg, type LocalLeg } from "./local-leg.ts";

export interface TielineOpts {
  hubUrl: string;          // wss://wopr.realwopr.ai/trunk
  name: string; region: string; joshua: "claude" | "period"; operator?: string;
  // What to ask the switchboard for. Both are requests, not facts: the hub
  // places the exchange and answers with the placement it actually made.
  slot?: string;           // WOPR, SCHOOL, ... ; omitted = next free wildcard
  world?: number | "NEW";  // a specific world, or a fresh one
  key?: string;            // the hub operator's key for a reserved world
  localComms: string;      // ws://127.0.0.1:8081
  localBridge: string;     // http://127.0.0.1:8000
  /** The local bridge's BRIDGE_INTERNAL_TOKEN. A machine call's local leg
   *  mints a TRUNK surface, and those two surfaces are internal-only (#74);
   *  a tieline that cannot prove it is the relay gets no session and every
   *  machine call refuses with `no session`. Omitted falls back to
   *  `process.env.BRIDGE_INTERNAL_TOKEN` inside `openLocalLeg`, which is
   *  what a host running this beside its own stack already has. */
  internalToken?: string;
  reconnect?: boolean;     // default true; tests pass false
  onAssigned?: (exchange: string, world: number, slot: string) => void;
  // Fires only for an INBOUND call: a call this host places is answered with
  // PLACED, not an OPEN (Switchboard.placeCall sends OPEN only to the
  // target), so this never fires for a call place() caused. origin is
  // present when a machine called, absent when a visitor did.
  onOpen?: (chan: number, origin?: CallOrigin) => void;
  /** Fires when any channel ends — one this host placed or one it answered.
   *  A placer is otherwise never told the callee hung up. */
  onClose?: (chan: number, reason?: string) => void;
}

/** A call this host placed. There is deliberately no `send`: the caller's own
 *  PROGRAM talks, through the session `place()` attached, and a fresh session's
 *  program greets on connect. */
export interface PlacedCall { chan: number; close(reason?: string): void }

export function startTieline(opts: TielineOpts): {
  stop: () => void;
  place: (to: CallTarget, on?: number) => Promise<PlacedCall | RefusedReason>;
  assigned: () => boolean;
} {
  let hub: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 5_000;
  let everAssigned = false;
  const channels = new Map<number, { local: WebSocket; buffer: string[] }>();
  // Machine-call ends, keyed by the same channel numbers `channels` uses. A
  // channel is in exactly one of the two maps: a visitor's dial or a machine's
  // local leg.
  const legs = new Map<number, LocalLeg>();
  // A machine call's leg is minted asynchronously (a session POST, then a
  // dial) — the hub's CLOSE for that chan can arrive before either finishes,
  // and `legs` has no entry yet for the CLOSE handler to find. This registry
  // is how that race gets remembered: a canceller per in-flight mint, so the
  // leg that eventually resolves finds out it was abandoned instead of
  // silently resurrecting a channel the hub has already forgotten.
  const pendingLegs = new Map<number, () => void>();
  const placing = new Map<number, (r: PlacedCall | RefusedReason) => void>();
  let nextCall = 1;

  const send = (f: TrunkFrame) => { if (hub?.readyState === WebSocket.OPEN) hub.send(JSON.stringify(f)); };

  async function handleRequest(f: Extract<TrunkFrame, { t: "REQUEST" }>): Promise<void> {
    if (!restAllowed(f.method, f.path)) {
      send({ t: "RESPONSE", rid: f.rid, status: 404, body: "{}" });
      return;
    }
    try {
      const res = await fetch(`${opts.localBridge}${f.path}`, {
        method: f.method,
        headers: f.body ? { "content-type": "application/json" } : undefined,
        body: f.body,
        signal: AbortSignal.timeout(8_000),
      });
      send({ t: "RESPONSE", rid: f.rid, status: res.status, body: await res.text() });
    } catch {
      send({ t: "RESPONSE", rid: f.rid, status: 502, body: "{}" });
    }
  }

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
    // Fire onOpen synchronously with the visitor path, not after the mint
    // resolves — a caller learns of an inbound call the instant it arrives,
    // whether or not the local leg then attaches successfully.
    opts.onOpen?.(f.chan, f.origin);
    let abandoned = false;
    pendingLegs.set(f.chan, () => { abandoned = true; });
    const leg = await openLocalLeg({
      bridgeUrl: opts.localBridge,
      commsUrl: opts.localComms,
      internalToken: opts.internalToken,
      surface: "trunk-call",
      origin: `world ${o.world} slot ${o.slot}`,
      send: (data) => send({ t: "FRAME", chan: f.chan, data }),
      close: (reason) => {
        if (legs.delete(f.chan)) { send({ t: "CLOSE", chan: f.chan, reason }); opts.onClose?.(f.chan, reason); }
      },
    });
    pendingLegs.delete(f.chan);
    if (leg === "refused") {
      // openLocalLeg already invoked the `close` callback above for this
      // failure — but `f.chan` had nothing registered under `legs` yet (the
      // leg had not resolved), so that guard's `legs.delete(f.chan)` was a
      // no-op and no CLOSE ever reached the hub. Without sending one here the
      // hub's channel entry for this call is never freed: a host whose bridge
      // is briefly down leaves a live entry in the hub's `channels` map for
      // every inbound machine call, goes "busy" to every further caller, and
      // leaves each of them on a connected-but-silent channel that was never
      // refused. Same fix, same reason, as `seededPort`'s in server.ts.
      //
      // Skip only if the hub already forgot this chan on its own (an incoming
      // CLOSE set `abandoned` first) — that CLOSE already freed the channel
      // there, the number may since have been reused, and its handler has
      // already fired the onClose below.
      //
      // The onOpen above fired the moment the call arrived, deliberately, so
      // the same close has to reach the same listener: a host that tracks live
      // calls through this pair — the tieline CLI does, and so will every
      // program that places calls of its own — otherwise counts a call that
      // was torn down on the wire before it ever had a local end.
      if (!abandoned) {
        send({ t: "CLOSE", chan: f.chan, reason: "no session" });
        opts.onClose?.(f.chan, "no session");
      }
      return;
    }
    // The hub already forgot this chan while the mint was in flight — close
    // the leg that just arrived instead of resurrecting an entry nothing will
    // ever send a second CLOSE for.
    if (abandoned) { leg.close(); return; }
    legs.set(f.chan, leg);
  }

  /** A call this host placed just got a hub-assigned channel (PLACED). Attach
   *  a local leg of its own — same asynchronous mint, same abandonment race,
   *  as openMachineChannel above — so the returned PlacedCall has something
   *  real to hang up. */
  async function attachPlaced(chan: number): Promise<PlacedCall> {
    // One channel, one ending. A PlacedCall is a HANDLE the host keeps, which
    // makes hangUp the one ending path that can be reached AFTER some other
    // path already ended this channel — by a host that hangs up inside its own
    // onClose, or simply later. Every path below sets the latch; hangUp reads
    // it. Without it that second hangup puts a CLOSE on the wire for a channel
    // number the hub freed and may since have reused, and fires a second
    // onClose for a call that ended once.
    let ended = false;
    const hangUp = (reason?: string) => {
      if (ended) return;
      ended = true;
      legs.get(chan)?.close(); legs.delete(chan);
      send({ t: "CLOSE", chan, reason });
      // Told here, not by the leg's own close callback: that callback is
      // latched behind `if (legs.delete(chan))`, and the line above already
      // took the entry, so it can never fire for a call this host hung up
      // itself. Without this, a host tracking live channels through onClose
      // would leak an entry for every call it closed. Still exactly one
      // onClose per ended channel: the leg's callback finds its latch false,
      // the hub does not echo a host's own CLOSE back, and `ended` above
      // stops this line running twice for one channel.
      opts.onClose?.(chan, reason);
    };
    let abandoned = false;
    pendingLegs.set(chan, () => { abandoned = true; });
    const leg = await openLocalLeg({
      bridgeUrl: opts.localBridge,
      commsUrl: opts.localComms,
      internalToken: opts.internalToken,
      surface: "trunk-caller",
      filterRitual: true,
      send: (data) => send({ t: "FRAME", chan, data }),
      close: (reason) => {
        // Set before the latch, not inside it: this fires for EVERY way the
        // local leg goes away, including the ones that already deleted the
        // entry themselves (an incoming CLOSE, a reconnect sweep). Those are
        // endings too, and a handle held past them must not reopen the wound.
        ended = true;
        if (legs.delete(chan)) { send({ t: "CLOSE", chan, reason }); opts.onClose?.(chan, reason); }
      },
    });
    pendingLegs.delete(chan);
    if (leg === "refused") {
      // Nothing was ever registered under `legs` for this chan, so the leg's
      // own `close` callback above found its latch false and sent no CLOSE —
      // leaving the hub holding a channel for a call that has no local end.
      // Free it explicitly, exactly as `openMachineChannel` and `seededPort`
      // do, or a placer with a sick bridge burns one of its channel budget
      // per attempt until it reconnects. `abandoned` guards the same race:
      // an incoming CLOSE already freed the channel there, and its handler
      // has already fired the onClose below.
      //
      // The host is told too. place() resolves with a real PlacedCall whether
      // or not a leg attached — that is deliberate, the hangup handle is not
      // conditional — so a refusal that only reached the hub would leave the
      // placer holding a live-looking handle for a channel that is already
      // gone, and waiting on an onClose that can never come.
      ended = true;
      if (!abandoned) {
        send({ t: "CLOSE", chan, reason: "no session" });
        opts.onClose?.(chan, "no session");
      }
    } else if (abandoned) {
      ended = true;
      // The hub already forgot this chan while the mint was in flight — close
      // the leg that just arrived instead of resurrecting an entry nothing
      // will ever send a second CLOSE for.
      leg.close();
    } else legs.set(chan, leg);
    return { chan, close: hangUp };
  }

  function connect(): void {
    if (stopped) return;
    // Did THIS attempt get as far as an ASSIGNED? The hub closes 4400 for any
    // frame it cannot decode, not only a REGISTER — so the code alone does not
    // say whether the placement was rejected or a live trunk hit one bad frame.
    // Reset per attempt, set in the ASSIGNED handler below. Hoisted to the
    // outer scope so `assigned()` below can read the same flag — no new state.
    everAssigned = false;
    hub = new WebSocket(opts.hubUrl);
    hub.on("open", () => {
      backoffMs = 5_000;
      send({ t: "REGISTER", v: 1, name: opts.name, region: opts.region,
             joshua: opts.joshua, operator: opts.operator,
             slot: opts.slot, world: opts.world, key: opts.key });
    });
    hub.on("message", (data) => {
      let f: TrunkFrame;
      try { f = decodeTrunkFrame(data.toString()); } catch { return; }
      if (f.t === "ASSIGNED") { everAssigned = true; opts.onAssigned?.(f.exchange, f.world, f.slot); }
      else if (f.t === "OPEN") openChannel(f);
      else if (f.t === "FRAME") {
        const leg = legs.get(f.chan);
        if (leg) { leg.deliver(f.data); return; }
        const c = channels.get(f.chan);
        if (!c) return;
        if (c.local.readyState === WebSocket.OPEN) c.local.send(f.data);
        else c.buffer.push(f.data);
      } else if (f.t === "CLOSE") {
        pendingLegs.get(f.chan)?.(); pendingLegs.delete(f.chan);
        legs.get(f.chan)?.close(); legs.delete(f.chan);
        channels.get(f.chan)?.local.close(); channels.delete(f.chan);
        opts.onClose?.(f.chan, f.reason);
      }
      else if (f.t === "REQUEST") void handleRequest(f);
      else if (f.t === "PING") send({ t: "PONG" });
      else if (f.t === "PLACED") {
        const resolve = placing.get(f.call);
        placing.delete(f.call);
        if (resolve) void attachPlaced(f.chan).then(resolve);
      }
      else if (f.t === "REFUSED") { placing.get(f.call)?.(f.reason); placing.delete(f.call); }
    });
    const retry = () => {
      for (const c of channels.values()) c.local.close();
      channels.clear();
      for (const leg of legs.values()) leg.close();
      legs.clear();
      // Mark every in-flight mint abandoned before dropping the map — the
      // dropped hub connection means no CLOSE is ever coming for these, and
      // a reconnect reuses the same small chan numbers, so a stale mint
      // resolving later must not resurrect (or worse, overwrite a genuinely
      // new call's) entry in the post-reconnect `legs` map.
      for (const cancel of pendingLegs.values()) cancel();
      pendingLegs.clear();
      // The hub is gone — every in-flight place() would otherwise hang
      // forever waiting for a PLACED/REFUSED that can no longer arrive.
      // Resolve (never reject) each one with "offline" and drop the map, so
      // a fresh connect() starts with no stale waiters.
      for (const resolve of placing.values()) resolve("offline");
      placing.clear();
      if (stopped || opts.reconnect === false) return;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    };
    hub.on("close", (closeCode: number, reason: Buffer) => {
      // A refusal is an answer, not an outage: NO CIRCUITS (4460), SLOT TAKEN
      // (4461), WORLD RESERVED (4462), switchboard full (4409). Redialling
      // would spam the hub with a REGISTER it just refused, so stop for good
      // and say why.
      if (closeCode === 4409 || closeCode === 4460 || closeCode === 4461 || closeCode === 4462) {
        stopped = true;
        console.error(`LINE REFUSED — ${reason.toString().toUpperCase() || "SWITCHBOARD REFUSED"}`);
      } else if (closeCode === 4400 && !everAssigned) {
        // The hub could not even read our REGISTER — an off-roster slot, a
        // world that is not a number or NEW. That verdict is deterministic:
        // the same frame will be rejected every time, so redialling is an
        // infinite loop with no LINE REFUSED to explain it. Stop and say what
        // to fix.
        //
        // Only BEFORE an ASSIGNED, though: the hub closes 4400 for any
        // undecodable frame, including one arriving mid-call on an exchange it
        // already placed. Treating that as terminal would let a single corrupt
        // frame take a live exchange off the board for good — and blame
        // TIELINE_SLOT/TIELINE_WORLD, which were fine. Post-ASSIGNED it is an
        // outage like any other: fall through to the backoff retry.
        stopped = true;
        console.error(
          `LINE NOT ACCEPTED — ${reason.toString().toUpperCase() || "MALFORMED REGISTER"}` +
          ` — CHECK TIELINE_SLOT AND TIELINE_WORLD`,
        );
      }
      retry();
    });
    hub.on("error", (err) => {
      // close fires after error and drives the reconnect; without this line a
      // refused/reset hub connection is invisible to the operator.
      console.error(`TIE LINE DOWN, RETRYING — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  connect();
  return {
    stop: () => { stopped = true; hub?.close(); for (const c of channels.values()) c.local.close(); },
    /** Place a call to another exchange's world-local slot, over the trunk.
     *
     *  `on` is the one-hop cap, and the hub can only believe what it says:
     *  the switchboard cannot see causality. If you are placing this call
     *  BECAUSE you are answering an inbound one, you MUST pass that inbound
     *  channel — the `chan` your `onOpen` was given — as `on`. The hub then
     *  refuses "depth" if that channel came from a machine, which is what
     *  stops a ring forming. Omit `on` only for a call this host originated
     *  by itself. Omitting it on a relayed call is not a shortcut; it is the
     *  loop-prevention mechanism switched off.
     *
     *  The returned call attaches a local leg of its own: a session on this
     *  host's bridge, dialled over this host's /link, whose program is what
     *  actually talks. Hang it up with close(); opts.onClose fires when the
     *  channel ends, whichever end ended it. */
    place(to: CallTarget, on?: number): Promise<PlacedCall | RefusedReason> {
      // No socket, or one already on its way out: resolve rather than
      // reject, so a caller handles "could not place" in one branch instead
      // of a try/catch plus a branch.
      const h = hub;
      if (!h || h.readyState === WebSocket.CLOSING || h.readyState === WebSocket.CLOSED) {
        return Promise.resolve("offline");
      }
      const dial = (resolve: (r: PlacedCall | RefusedReason) => void) => {
        const call = nextCall++;
        placing.set(call, resolve);
        h.send(JSON.stringify({ t: "PLACE", call, on, to }));
      };
      if (h.readyState === WebSocket.OPEN) return new Promise(dial);
      // Still mid-handshake (a caller can reach here the instant after
      // startTieline() returns, before "open" has had a chance to fire): wait
      // for it to open before sending, rather than calling a socket that just
      // has not finished connecting yet "offline". If it dies before opening,
      // that IS offline — settle then, never leave the promise hanging.
      return new Promise((resolve) => {
        const onOpen = () => { h.off("close", onClose); dial(resolve); };
        const onClose = () => { h.off("open", onOpen); resolve("offline"); };
        h.once("open", onOpen);
        h.once("close", onClose);
      });
    },
    // A startup gate, not a liveness signal: true once ASSIGNED has arrived
    // for the current connect attempt, but it does NOT go false the instant
    // the trunk drops — it only clears when the next connect() attempt
    // begins (everAssigned is reset there). So after a disconnect this can
    // read true for the whole backoff window, stale by up to 60s. Fine for
    // "wait for registration before placing a first call"; wrong for "am I
    // connected right now" — check the socket for that, as place() does.
    assigned: () => everAssigned,
  };
}

// CLI entry: `npm run tieline` on a host machine.
if (import.meta.url === `file://${process.argv[1]}`) {
  // Check what the hub checks, before dialling. A bad slot or world is refused
  // with a malformed-frame close that says nothing about which field was
  // wrong; caught here it is one readable line instead.
  const rawSlot = process.env.TIELINE_SLOT?.toUpperCase() || undefined;
  if (rawSlot !== undefined && !ALL_SLOTS.includes(rawSlot)) {
    console.error(`TIELINE_SLOT MUST BE ONE OF: ${ALL_SLOTS.join(" ")}`);
    process.exit(1);
  }
  const rawWorld = process.env.TIELINE_WORLD?.toUpperCase() || undefined;
  if (rawWorld !== undefined && rawWorld !== "NEW" &&
      !(/^[0-9]+$/.test(rawWorld) && Number(rawWorld) >= 1)) {
    console.error("TIELINE_WORLD MUST BE A WORLD NUMBER (1 OR GREATER) OR NEW");
    process.exit(1);
  }

  startTieline({
    hubUrl: process.env.TRUNK_HUB_URL ?? "wss://wopr.realwopr.ai/trunk",
    name: process.env.TIELINE_NAME ?? "UNNAMED EXCH",
    region: process.env.TIELINE_REGION ?? "SOMEWHERE",
    joshua: (process.env.TIELINE_JOSHUA as "claude" | "period") ?? "period",
    operator: process.env.TIELINE_OPERATOR,
    slot: rawSlot,
    world: rawWorld === "NEW" ? "NEW" : rawWorld ? Number(rawWorld) : undefined,
    // Only needed for a reserved world (world 1 is the flagship's); the hub
    // operator issues it. Opaque here — the hub is the only thing that reads it.
    key: process.env.TIELINE_RESERVE_KEY || undefined,
    localComms: process.env.TIELINE_LOCAL_COMMS ?? "ws://127.0.0.1:8081",
    localBridge: process.env.TIELINE_LOCAL_BRIDGE ?? "http://127.0.0.1:8000",
    onAssigned: (exchange, world, slot) => {
      console.log(`TIE LINE UP — YOU ARE WORLD ${world} / ${slot} — EXCHANGE ${exchange}`);
      console.log(`share: https://realwopr.ai/war-room.html?exch=${exchange}`);
    },
  });
}
