// The comms layer as a service: a WebSocket proxy that sits between the
// surfaces (public, /link) and the bridge (internal Compose network), imposing
// the era constraints on both directions (docs/comms-protocol.md §1;
// deployment.md D1/D3). It never inspects payloads and holds no game state.
//
// Surface connects:  ws://<host>/link?surface=home-terminal&session=<uuid>&token=<t>
// Comms connects on: ws://bridge:8000/ws/session/<uuid>?token=<t>
//                    (header x-wopr-internal-token = BRIDGE_INTERNAL_TOKEN, D3)

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { configFromEnv, resolveLink, type CommsConfig } from "./config.ts";
import { decodeEnvelope, encodeEnvelope, type Envelope } from "./envelope.ts";
import { LinkShaper } from "./shaper.ts";
import { runHandshake, type HandshakeOpts } from "./handshake.ts";
import { Switchboard, decodeTrunkFrame, restAllowed, TRUNK_MAX_FRAME_BYTES,
         type CallTarget, type LocalSlot, type SeatBridge, type TrunkFrame,
         type TrunkPort } from "./trunk.ts";
import { openLocalLeg, type LocalLeg } from "./local-leg.ts";
import { SeatRegistry } from "./seats.ts";

/** How much a caller may say into a line that is still ringing before the hub
 *  hangs up on it. Four frames at the trunk's per-frame cap: enough for a
 *  program's greeting, which is what the hold exists for, and far short of a
 *  buffer worth filling on purpose. */
const SEAT_HELD_MAX_BYTES = TRUNK_MAX_FRAME_BYTES * 4;

export interface ServerOpts {
  port?: number;
  bridgeUrl?: string;
  internalToken?: string;
  config?: CommsConfig;
  handshake?: HandshakeOpts;
  publicBase?: string;
  /** How long a carrier drop waits for the downstream shaper to play out what
   *  the far end already sent (#62). Defaults to 30s. */
  drainTimeoutMs?: number;
  trunk?: {
    maxExchanges?: number;
    maxChannels?: number;
    maxWorlds?: number;
    reservedWorlds?: number[];
    reserveKey?: string;
    localWorld?: LocalSlot[];
    pingIntervalMs?: number;
    relayPingMs?: number;
    registerTimeoutMs?: number;
  };
  seats?: {
    ringTimeoutMs?: number;
    newId?: () => string;
    maxSeats?: number;
    /** How long a `/seat` socket gets to send `SEAT?` before it is closed
     *  `4408`, mirroring `trunk.registerTimeoutMs`/`trunkWss`'s "no register"
     *  guard just below. Defaults to 20s, the same window that guard uses. */
    handshakeTimeoutMs?: number;
    /** The seeded slot a direct `/link` dial mints its handle against. Every
     *  seeded world-1 entry shares `link: <wsBase>/link`, and the slot a
     *  direct dial actually reached rides in the *session* the terminal
     *  minted with the bridge — which this hub leg never sees. So a direct
     *  dial cannot mint a handle for whichever seeded program the terminal
     *  meant to reach; it mints instead for the hub's own Joshua line, the
     *  only seeded slot with a reason to ring anyone back (the film's
     *  callback beat is Joshua's alone). The resulting ORIGIN envelope is
     *  still delivered to whichever program the session actually reached —
     *  which may be a sibling seeded program, not Joshua — so the handle it
     *  carries names WOPR's exchange regardless of who ends up reading it.
     *  Defaults to "WOPR". */
    homeSlot?: string;
    /** @internal Test seam only — NOT a supported extension point into a
     *  security-critical registry. Use this exact registry instead of
     *  constructing one from the options above.
     *
     *  A seat can now be rung end to end over the wire (`SeatBridge`, below),
     *  so this is no longer the only way to reach `ring()`. What it is still
     *  needed for is OBSERVING a leg's state — whether a hold is outstanding,
     *  whether the leg is gone — which nothing on the wire reports. A test
     *  that must wait for a hold to be released, rather than sleep and hope,
     *  has to hold the same registry instance the server uses internally. */
    registry?: SeatRegistry;
  };
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

/** A seeded world-1 slot's "host". It speaks the same TrunkFrame the
 *  switchboard sends down a real trunk socket, but instead of a socket it
 *  opens a local leg against the hub's own bridge. That is the whole trick:
 *  the flagship becomes callable without a trunk back to itself.
 *
 *  `attach` is the placing half of the same trick: a call THIS seed places
 *  (via POST /trunk/place) gets an internal `peerPort` from the switchboard,
 *  not an OPEN — so nothing ever mints a local leg for the placer's end
 *  unless something calls attach() for it. startServer's route calls it,
 *  right after a successful placeCall.
 *
 *  `up` is how this port talks back to the switchboard — ordinarily
 *  `(f) => switchboard.handleHostFrame(code, f)`, but taken as a plain
 *  callback (not a closure over `switchboard`/`code`) so this function can
 *  live at module scope and be unit-tested directly, the way
 *  `openLocalLeg` is tested in local-leg.test.ts, without standing up a full
 *  Switchboard and HTTP server. */
export function seededPort(seed: LocalSlot, bridgeUrl: string, commsUrl: string,
                           up: (f: TrunkFrame) => void): TrunkPort & { attach(chan: number): void } {
  const legs = new Map<number, LocalLeg>();
  // A machine call's leg is minted asynchronously (a session POST, then a
  // dial) — a CLOSE for that chan can arrive before the mint resolves, and
  // `legs` has no entry yet for the CLOSE handler to find. This registry
  // remembers a canceller per in-flight mint, mirroring tieline.ts's
  // pendingLegs: the leg that eventually resolves finds out it was
  // abandoned instead of silently resurrecting a channel nothing will ever
  // close again.
  const pendingLegs = new Map<number, () => void>();
  const mint = (chan: number, params: {
    surface: "trunk-call" | "trunk-caller"; origin?: string; filterRitual?: boolean;
  }) => {
    let abandoned = false;
    pendingLegs.set(chan, () => { abandoned = true; });
    void openLocalLeg({
      // ServerOpts.bridgeUrl is a WEBSOCKET url (`ws://bridge:8000`,
      // server.ts:50) — it is what /link dials for /ws/session/<id>.
      // openLocalLeg mints over HTTP against the same host.
      bridgeUrl: bridgeUrl.replace(/^ws/, "http"),
      commsUrl,
      surface: params.surface,
      system: seed.system,
      origin: params.origin,
      filterRitual: params.filterRitual,
      send: (data) => up({ t: "FRAME", chan, data }),
      // Guarded against double-fire: openLocalLeg binds this same handler
      // to both the socket's "close" and "error" events, so one failure
      // invokes it twice. Without the delete-returns-true guard that sends
      // two CLOSE frames for one call, on a channel number that may since
      // have been reused.
      close: (reason) => { if (legs.delete(chan)) up({ t: "CLOSE", chan, reason }); },
    }).then((leg) => {
      pendingLegs.delete(chan);
      if (leg === "refused") {
        // openLocalLeg already invoked the `close` callback above for this
        // failure — but `chan` had nothing registered under `legs` yet (the
        // leg had not resolved), so that guard's `legs.delete(chan)` was a
        // no-op and no CLOSE ever went upstream. Without sending one here,
        // the switchboard's channel entry for `chan` is never freed —
        // sweepDead skips seeded exchanges, so nothing else ever reaps it,
        // and repeated failed mints (e.g. a bridge outage) slowly exhaust
        // the seeded slot's channel budget until a process restart.
        //
        // Skip only if the hub already forgot this chan on its own (an
        // incoming CLOSE set `abandoned` first) — that CLOSE already told
        // the switchboard the channel is gone, and the number may since
        // have been reused.
        if (!abandoned) up({ t: "CLOSE", chan, reason: "no session" });
        return;
      }
      // The hub already forgot this chan while the mint was in flight —
      // close the leg that just arrived instead of resurrecting an entry
      // nothing will ever send a second CLOSE for.
      if (abandoned) { leg.close(); return; }
      legs.set(chan, leg);
    });
  };
  return {
    send: (raw: string) => {
      let f: TrunkFrame;
      try { f = decodeTrunkFrame(raw); } catch { return; }
      if (f.t === "OPEN") {
        const o = f.origin;
        mint(f.chan, {
          surface: "trunk-call",
          origin: o === undefined ? undefined
            : "seat" in o ? `seat ${o.seat}` : `world ${o.world} slot ${o.slot}`,
        });
      } else if (f.t === "FRAME") legs.get(f.chan)?.deliver(f.data);
      else if (f.t === "CLOSE") {
        pendingLegs.get(f.chan)?.(); pendingLegs.delete(f.chan);
        legs.get(f.chan)?.close(); legs.delete(f.chan);
      }
      else if (f.t === "PING") up({ t: "PONG" });
      // The hub synthesizes a seed's directory entry itself, so nothing ever
      // needs to ask a seeded slot for REST. Answer honestly rather than hang.
      else if (f.t === "REQUEST") up({ t: "RESPONSE", rid: f.rid, status: 404, body: "{}" });
    },
    close: () => {
      for (const cancel of pendingLegs.values()) cancel();
      pendingLegs.clear();
      for (const l of legs.values()) l.close();
      legs.clear();
    },
    // The answering end paces (trunk-call, dialup-1200); the end that
    // PLACED the call must not (trunk-caller, off) — two shapers in series
    // would halve throughput for no fiction. filterRitual: true because a
    // calling program must not be handed its own handshake/control frames.
    attach: (chan: number) => mint(chan, { surface: "trunk-caller", filterRitual: true }),
  };
}

export async function startServer(opts: ServerOpts = {}): Promise<RunningServer> {
  const config = opts.config ?? configFromEnv();
  const port = opts.port ?? Number(process.env.COMMS_PORT ?? 8081);
  const bridgeUrl = opts.bridgeUrl ?? process.env.BRIDGE_WS_URL ?? "ws://bridge:8000";
  const internalToken = opts.internalToken ?? process.env.BRIDGE_INTERNAL_TOKEN ?? "";
  const handshakeOpts: HandshakeOpts = {
    failRate: Number(process.env.COMMS_FAIL_RATE ?? 0),
    ...opts.handshake,
  };
  // A drop plays the line out before it announces carrier loss, but a
  // pathological queue must not hold the visitor's socket open indefinitely:
  // 30s is ~900 characters at 300 baud, far more than any sign-off display and
  // far less than a runaway feed would take.
  const drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  // The fallback publicBase is resolved AFTER listen(): under COMMS_PORT=0
  // the pre-listen `port` is 0, which would bake ":0" into every directory
  // entry. Explicit configuration always wins.
  let publicBase = opts.publicBase ?? process.env.TRUNK_PUBLIC_BASE ?? "";
  // TRUNK_MAX_WORLDS is operator-supplied text: a typo (or "") parses to NaN/0,
  // and `world > NaN` is false, which would silently turn the explicit-world
  // REGISTER path into an unbounded world allocator. Only a whole number >= 1
  // is honored; anything else falls back to the documented default of 8.
  const envMaxWorlds = Number(process.env.TRUNK_MAX_WORLDS);
  const defaultMaxWorlds = Number.isInteger(envMaxWorlds) && envMaxWorlds >= 1 ? envMaxWorlds : 8;
  // TRUNK_RESERVED_WORLDS is a comma list, vetted token by token the same way
  // TRUNK_MAX_WORLDS is: a token that is not a whole number >= 1 is dropped
  // rather than reserving world NaN.
  //
  // Unset — or empty/whitespace, which is exactly what an unset variable
  // expands to in a .env or a compose file — means the documented default:
  // world 1, the flagship's. Reading a blank value as "reserve nothing" would
  // silently open the flagship's world, which is the wrong way to fail.
  // Opting out stays possible, it just has to be typed on purpose: a value
  // with tokens but no usable world number (`TRUNK_RESERVED_WORLDS=none`)
  // reserves nothing.
  const envReserved = process.env.TRUNK_RESERVED_WORLDS;
  const defaultReservedWorlds = envReserved === undefined || envReserved.trim() === ""
    ? [1]
    : envReserved.split(",").map((t) => Number(t.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1);
  // TRUNK_LOCAL_WORLD is the hub's own world-1 manifest: a JSON array of
  // LocalSlot. Two failure modes, two behaviours, on purpose. Unparseable or
  // not an array = a truncated/garbled value: say so once on stderr and seed
  // NOTHING, because a broken manifest must neither take the hub down nor
  // half-seed the board. Parseable but invalid (a bad slot, a duplicate) is a
  // deploy error the operator typed: the Switchboard ctor throws and startup
  // fails, rather than serving a directory nobody wrote.
  let envLocalWorld: LocalSlot[] | undefined;
  const rawLocalWorld = process.env.TRUNK_LOCAL_WORLD;
  if (rawLocalWorld !== undefined && rawLocalWorld.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(rawLocalWorld);
      if (!Array.isArray(parsed)) throw new Error("not an array");
      envLocalWorld = parsed as LocalSlot[];
    } catch {
      console.error("trunk: ignoring malformed TRUNK_LOCAL_WORLD");
    }
  }
  const trunkLocalWorld = opts.trunk?.localWorld ?? envLocalWorld ?? [];
  // Constructed here, immediately before the Switchboard, rather than beside
  // the WebSocketServers below: a SeatBridge closing over `seats` is threaded
  // into the Switchboard's own options, so `seats` must exist before that
  // construction or the reference is a temporal-dead-zone ReferenceError at
  // startup.
  const seats = opts.seats?.registry ?? new SeatRegistry({
    ringTimeoutMs: opts.seats?.ringTimeoutMs,
    newId: opts.seats?.newId,
  });

  // The seat's side of a ring. The hub paces it, because the ANSWERING end
  // paces: the shaper below runs at the profile the seat declared when it
  // opened `/seat`. A machine's own leg does not shape (its surface is
  // trunk-caller, baud 0), so this is the ONE shaper in a machine -> seat
  // call, and the seat -> machine direction crosses unpaced.
  //
  // `seatCalls` holds the ender for whatever ring or call a seat is currently
  // on, so it can be ended from outside — specifically by the seat's own
  // socket going away, which the registry cannot report for an ANSWERED call
  // (it fires `timedOut()` for a PENDING ring, and has no notification for a
  // call already in progress). At most one entry per seat: `seats.ring`
  // refuses a second ring "busy" while one is live.
  const seatCalls = new Map<string, (reason: string, playOut: boolean) => void>();
  /** End the ring or call a seat is on, from outside the bridge. A no-op if it
   *  has already ended by any other door.
   *
   *  Never plays the line out: the only caller is the seat's own socket going
   *  away, and there is nobody left to play it out to. */
  const endSeatCall = (id: string, reason: string): void => {
    seatCalls.get(id)?.(reason, false);
  };

  const seatBridge: SeatBridge = {
    resolve: (handle, code) => {
      const leg = seats.resolve(handle, code);
      return leg === "seat-gone" ? "seat-gone" : { id: leg.id };
    },
    ring: (id, callerName, wire) => {
      const leg = seats.leg(id);
      if (!leg) return "seat-gone";
      // A seat is refused `/seat` unless its surface resolves, so this is
      // belt-and-braces — but a seat that could be rung and never heard is
      // worse than one that is simply not there.
      const link = resolveLink(config, leg.surface);
      if (!link) return "seat-gone";
      const down = new LinkShaper(link.profile, link.name, id,
        (e: Envelope) => leg.port.send(encodeEnvelope(e)));
      const held: string[] = [];
      let heldBytes = 0;
      let answered = false;
      let ended = false;
      const push = (raw: string) => {
        let e: Envelope;
        // Not an envelope: the hub never inspects a payload further than the
        // frame it must re-time, so there is nothing to do but drop it.
        try { e = decodeEnvelope(raw); } catch { return; }
        down.send({ kind: e.kind, payload: e.payload, eom: e.eom });
      };

      /** Play the line out, THEN drop carrier — issue #62, the same order the
       *  `/link` leg's `dropCarrier` uses and for the same reason. At 300 baud
       *  the machine's last line is still trickling through `down` when it
       *  hangs up, and `down.close()` discards the whole paced queue: closing
       *  in front of the playout swallows a system's parting words. NO CARRIER
       *  goes out via `sendImmediate` because it is a line-state transition,
       *  not paced serial data (#88), and it is what tells the seat the call
       *  is over — nothing else on this leg says so.
       *
       *  Not awaited by `end`: the MACHINE must learn the call ended at once,
       *  and only the seat's ear is worth waiting for. */
      const playOutAndDrop = async () => {
        await down.drain(drainTimeoutMs);
        down.sendImmediate({ kind: "control", payload: "NO CARRIER" });
        down.close();
      };

      /** Every door out of this call leads here, once.
       *
       *  `playOut` is false only when the seat itself has gone: there is
       *  nobody left to hear the playout, and draining into a closed socket
       *  would keep the shaper's timers alive for the whole drain window to
       *  deliver nothing. */
      const end = (reason: string, playOut = true) => {
        if (ended) return;
        ended = true;
        seatCalls.delete(id);
        // Disarm a ring still pending in the registry. Without this, a caller
        // that hangs up (or whose trunk drops) mid-ring leaves `leg.ring`
        // armed: the seat goes on ringing for a caller that is gone, is
        // "busy" to everyone else until the 30s timer, and — if the visitor
        // presses ANSWER inside that window — takes a hold that this already
        // latched `end` can never release. Safe re-entrantly: the registry
        // clears `leg.ring` BEFORE invoking `rejected`, so the reject that
        // arrives from the seat itself finds no ring on the way back in.
        //
        // The two branches are exclusive and both matter: ONLY an answered
        // ring took a hold, so releasing after a rejected or unanswered one
        // would decrement a hold some other holder is still relying on (a leg
        // this seat dialled out on) and free a seat that is genuinely
        // mid-conversation.
        if (answered) seats.release(id);
        else seats.reject(id);
        seats.detach(id);
        wire.onEnd(reason);
        if (playOut) void playOutAndDrop();
        else down.close();
      };

      const outcome = seats.ring(id, callerName, {
        answered: () => {
          // The ring is disarmed by `end` before it latches, so this should be
          // unreachable after an end. Belt and braces: answering a call that
          // has already ended would take a hold nothing is left to release.
          if (ended) return;
          answered = true;
          seats.attach(id, wire.toMachine);
          // The caller greeted the moment it connected, before anyone had
          // picked up. Those are its first words, and this is where they go.
          for (const d of held.splice(0)) push(d);
          heldBytes = 0;
        },
        rejected: () => end("rejected"),
        timedOut: () => end("no answer"),
      });
      if (outcome !== "ringing") return outcome;
      // Filed only if the ring is still live: an injected timer that fires
      // synchronously inside ring() would already have ended it.
      if (!ended) seatCalls.set(id, end);
      return {
        send: (data: string) => {
          if (answered) { push(data); return; }
          // Holding the caller's first words is the point; holding an
          // unbounded stream of them is a hole. This is a mutual-untrust
          // boundary — any exchange holding a handle can PLACE and then write
          // frames at the per-frame cap for the whole ring window with no
          // consumer, times every channel it can open. The per-frame cap and
          // maxChannels bound the COUNT, not the total, so bound the total
          // here and hang up rather than grow.
          heldBytes += Buffer.byteLength(data);
          if (heldBytes > SEAT_HELD_MAX_BYTES) { end("greeting exceeds hold capacity"); return; }
          held.push(data);
        },
        close: (_code?: number, reason?: string) => end(reason ?? "call ended"),
      };
    },
  };

  const switchboard = new Switchboard({
    ...opts.trunk,
    seats: seatBridge,
    maxWorlds: opts.trunk?.maxWorlds ?? defaultMaxWorlds,
    reservedWorlds: opts.trunk?.reservedWorlds ?? defaultReservedWorlds,
    localWorld: trunkLocalWorld,
    // `|| undefined` so an empty TRUNK_RESERVE_KEY does not shadow an
    // opts-supplied key. The invariant that an empty key unlocks nothing lives
    // in the Switchboard, which covers this path and the opts path alike.
    reserveKey: opts.trunk?.reserveKey ?? (process.env.TRUNK_RESERVE_KEY || undefined),
  });

  const httpServer = createServer((req, res) => { void handleHttp(req, res); });
  const linkWss = new WebSocketServer({ noServer: true });
  // Frame-size caps (D-none, closed in this hardening pass): ws defaults
  // maxPayload to 100 MB, so with none set here a single WS frame on either
  // trunk leg would let a hostile host or visitor make the shared hub
  // materialize (and, for visitors, re-stringify twice: toString + the
  // FRAME envelope) up to 100 MB per message — a memory/bandwidth DoS of the
  // process that also serves the production `/link`. `linkWss` (direct
  // surface<->bridge, not trunk-relayed) is left at the ws default: it's an
  // existing, unrelated production path and changing its behavior isn't part
  // of this fix.
  //
  // Arithmetic: TRUNK_MAX_FRAME_BYTES (8192) is the app-level cap
  // `decodeTrunkFrame` already enforces on a full TrunkFrame JSON string
  // (trunk.ts). The host leg (`trunkWss`, /trunk) carries exactly those
  // frames, so its ws-level cap is the same limit plus a small headroom
  // (+512 bytes) so ws never clips a frame `decodeTrunkFrame` would still
  // accept (e.g. multi-byte UTF-8 length quirks at the boundary).
  //
  // The visitor leg (`relayWss`, /x/<code>/link) carries raw envelope bytes,
  // not a TrunkFrame — `Switchboard.clientFrame` wraps whatever the visitor
  // sends as the `data` field of a `{"t":"FRAME","chan":N,"data":"..."}`
  // envelope before it crosses the trunk leg. That wrapping adds ~30-40
  // bytes of JSON overhead (keys/braces/chan digits) plus JSON-string
  // escaping of the payload, both of which only grow the byte count. So the
  // visitor leg is capped at TRUNK_MAX_FRAME_BYTES itself (not +512): a
  // visitor frame at that cap, once wrapped, fits inside the trunk leg's
  // (8192 + 512) allowance for ordinary payloads, and a visitor already
  // over the raw cap is refused before the hub ever builds the envelope.
  const trunkWss = new WebSocketServer({ noServer: true, maxPayload: TRUNK_MAX_FRAME_BYTES + 512 });
  const relayWss = new WebSocketServer({ noServer: true, maxPayload: TRUNK_MAX_FRAME_BYTES });
  const seatWss = new WebSocketServer({ noServer: true, maxPayload: TRUNK_MAX_FRAME_BYTES });
  // Sockets that have connected to /seat but not yet minted a leg (no SEAT?
  // yet) still hold a slot: without counting them, maxSeats means nothing —
  // an attacker just holds arbitrarily many un-minted sockets open, each
  // invisible to `seats.size`. Incremented on connect, decremented the
  // instant a socket either mints (folded into `seats.size` instead) or goes
  // away for any other reason (see `releasePending` in seatWss's handler).
  let pendingSeats = 0;

  httpServer.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://comms.invalid").pathname;
    const target = path === "/link" ? linkWss
      : path === "/trunk" ? trunkWss
      : path === "/seat" ? seatWss
      : /^\/x\/[A-Z2-9]{6}\/link$/.test(path) ? relayWss
      : null;
    if (!target) { socket.destroy(); return; }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  linkWss.on("connection", (client, req) => {
    const url = new URL(req.url ?? "/link", "http://comms.invalid");
    const surface = url.searchParams.get("surface") ?? "";
    const session = url.searchParams.get("session") ?? "";
    const token = url.searchParams.get("token") ?? "";

    const resolved = resolveLink(config, surface);
    if (!resolved || !session) {
      client.close(4400, "unknown surface or missing session");
      return;
    }
    const { name: linkName, profile, authenticName } = resolved;
    // The ritual KIND belongs to the surface's authentic link; `fast` mode only
    // collapses its timing to an instant CONNECTED (§4).
    const handshakeKind = config.profiles[authenticName].handshake;

    // A direct dial reaches the hub's own bridge, and which seeded slot it
    // reached rides in the session the terminal minted — which this leg never
    // sees. So the handle is minted for the hub's own Joshua line: the only
    // seeded slot with a reason to ring anyone back. The ORIGIN envelope
    // below is still delivered to whichever program this session's bridge
    // actually connects to, which — because the leg can't see the session —
    // may be a sibling seeded program, not Joshua: the handle names WOPR's
    // exchange regardless of who ends up reading it.
    const seatToken = url.searchParams.get("seat");
    const homeCode = switchboard.seededCode(opts.seats?.homeSlot ?? "WOPR");
    const seatLeg = seatToken ? seats.byToken(seatToken) : undefined;
    let handle: string | undefined;
    if (seatToken && homeCode) {
      try {
        handle = seats.mint(seatToken, homeCode);
      } catch (err) {
        // Same capability-escape handling as seatWss's open() and relayWss's
        // mint() — see seats.ts.
        console.error(`seat: mint() failed for surface "${surface}":`,
                      err instanceof Error ? err.message : err);
        client.close(1011, "seat registry error");
        return;
      }
    }
    if (seatLeg) seats.hold(seatLeg.id);

    // One shaper per direction; seq is monotonic per direction (§5).
    const down = new LinkShaper(profile, linkName, session, (e: Envelope) => {
      if (client.readyState === WebSocket.OPEN) client.send(encodeEnvelope(e));
    });

    let upstream: WebSocket | null = null;
    let up: LinkShaper | null = null;
    const upstreamBuffer: Envelope[] = [];
    // Disclosed on the same uniform rule as every other path: pushed before
    // dial() runs, so it is the first thing the bridge receives.
    if (handle) {
      upstreamBuffer.push({ v: 1, session, seq: 0, kind: "control",
                            link: linkName, payload: `ORIGIN seat ${handle}`, eom: true });
    }
    let closed = false;

    // Protocol-level keepalive (D3): a 300-baud reader can sit idle far past
    // proxy/tunnel idle timeouts (Cloudflare ~100s), so ping both legs.
    const keepalive = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
      if (upstream && upstream.readyState === WebSocket.OPEN) upstream.ping();
    }, 30_000);

    const teardown = (code = 1000, reason = "") => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      if (seatLeg) seats.release(seatLeg.id);
      down.close();
      up?.close();
      try { upstream?.close(); } catch { /* already closed */ }
      if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    };

    /** An orderly carrier drop: play out what the far end already put on the
     *  wire, THEN drop. The node's DROP path sends its sign-off display and
     *  closes the socket immediately behind it, so at authentic baud that
     *  display is still trickling through `down` when the upstream close
     *  lands — and teardown()'s down.close() discards the whole paced queue,
     *  which swallowed the parting words on every real 300-baud call (#62).
     *  The modem metaphor agrees: the far end's last bytes were already on the
     *  wire when carrier dropped.
     *
     *  NO CARRIER still goes out via sendImmediate() — it is a line-state
     *  transition, not paced serial data (#88) — but now behind the playout
     *  rather than in front of it. The wait is bounded, and a visitor who
     *  hangs up mid-playout wins: teardown() closes `down`, which settles the
     *  drain at once, and the `closed` guard stops us re-announcing. */
    const dropCarrier = async (code: number, reason: string) => {
      if (closed) return;
      await down.drain(drainTimeoutMs);
      if (closed) return;
      down.sendImmediate({ kind: "control", payload: "NO CARRIER" });
      teardown(code, reason);
    };

    const connectUpstream = () => {
      const target = `${bridgeUrl.replace(/\/$/, "")}/ws/session/${session}?token=${encodeURIComponent(token)}`;
      upstream = new WebSocket(target, {
        headers: internalToken ? { "x-wopr-internal-token": internalToken } : {},
      });
      up = new LinkShaper(profile, linkName, session, (e: Envelope) => {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(encodeEnvelope(e));
        }
      });
      upstream.on("open", () => {
        for (const e of upstreamBuffer.splice(0)) up!.send({ kind: e.kind, payload: e.payload, eom: e.eom });
      });
      upstream.on("message", (data) => {
        try {
          const e = decodeEnvelope(data.toString());
          down.send({ kind: e.kind, payload: e.payload, eom: e.eom });
        } catch {
          // Bridge sent something malformed; drop the frame, keep the line up.
        }
      });
      upstream.on("close", () => { void dropCarrier(1000, "upstream closed"); });
      upstream.on("error", () => {
        // No playout on the error path: an errored leg is a line already gone,
        // and what the shaper still holds may be exactly the truncated half of
        // whatever went wrong. Announce and drop.
        down.sendImmediate({ kind: "control", payload: "NO CARRIER" });
        teardown(1011, "upstream error");
      });
    };

    let dialing = false;
    const dial = async () => {
      // Ignore a redundant DIAL while the ritual is running or the upstream
      // socket exists (connecting or connected): re-running connectUpstream
      // would open a second upstream WebSocket without tearing down the first.
      if (dialing || upstream) return;
      dialing = true;
      try {
        const ok = await runHandshake(
          handshakeKind,
          config.mode,
          profile.baud,
          (state, detail) => down.send({ kind: "handshake", payload: `${state} ${detail}`.trim() }),
          handshakeOpts,
        );
        if (ok) connectUpstream();
        // On failure the line stays open; the surface may send a control DIAL to retry (§4).
      } finally {
        dialing = false;
      }
    };

    client.on("message", (data) => {
      let e: Envelope;
      try {
        e = decodeEnvelope(data.toString());
      } catch {
        client.close(4400, "malformed envelope");
        return;
      }
      if (e.kind === "control" && e.payload === "DIAL") {
        void dial();
        return;
      }
      if (e.kind === "control" && e.payload === "HANGUP") {
        teardown(1000, "hangup");
        return;
      }
      // The surface may react to CONNECTED before the upstream socket is up
      // (or even before dial() returns) — buffer, never drop. Frames sent
      // before a successful handshake die with the connection, which matches
      // §4: no application data crosses an unconnected line.
      if (upstream && upstream.readyState === WebSocket.OPEN && up) {
        up.send({ kind: e.kind, payload: e.payload, eom: e.eom });
      } else {
        upstreamBuffer.push(e);
      }
    });

    client.on("close", () => teardown());
    client.on("error", () => teardown(1011, "client error"));

    void dial();
  });

  trunkWss.on("connection", (host) => {
    let code: string | null = null;
    // A socket that connects to /trunk and never REGISTERs would otherwise be
    // held open forever — sweepDead only reaps registered exchanges — so an
    // anonymous connect-and-go-silent is a slow fd exhaustion. Give it a
    // window to REGISTER or drop it.
    const registerTimer = setTimeout(() => {
      if (code === null) host.close(4408, "no register");
    }, opts.trunk?.registerTimeoutMs ?? 20_000);
    host.on("message", (data) => {
      let f;
      try { f = decodeTrunkFrame(data.toString()); }
      catch { host.close(4400, "malformed trunk frame"); return; }
      if (f.t === "REGISTER") {
        if (code !== null) return;                       // one REGISTER per socket
        const placed = switchboard.register(host, f);
        // Four refusals, four codes: the host operator has to be able to tell
        // "this hub is out of room entirely" from "the world you asked for is
        // out of circuits" from "someone else already holds that slot" from
        // "that world is not open to you" — the middle two are fixable by
        // asking for a different world or slot, the last needs the hub
        // operator's key.
        if (placed === "full") { host.close(4409, "switchboard full"); return; }
        if (placed === "no-circuits") { host.close(4460, "no circuits available"); return; }
        if (placed === "slot-taken") { host.close(4461, "slot taken"); return; }
        if (placed === "world-reserved") { host.close(4462, "world reserved"); return; }
        code = placed.code;
        clearTimeout(registerTimer);
        host.send(JSON.stringify({ t: "ASSIGNED", exchange: placed.code, world: placed.world, slot: placed.slot }));
        return;
      }
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
      if (code !== null) switchboard.handleHostFrame(code, f);
    });
    const drop = () => {
      clearTimeout(registerTimer);
      if (code !== null) switchboard.unregister(code);
    };
    host.on("close", drop);
    host.on("error", drop);
  });

  // The second visitor leg. A terminal opens it when it starts and holds it for
  // the life of the session: while this socket is open the seat exists and can
  // be rung, and when it closes the seat is gone. Calls still run over /link
  // and /x/<CODE>/link — this leg carries rings, not conversations.
  //
  // The token is minted only in reply to an explicit client `SEAT?`, never on
  // connect. Sending it unprompted races the client's own connection setup:
  // over a fast (or same-process) link, the HTTP upgrade response and an
  // immediate follow-on frame can land in one read on the client, and a client
  // that attaches its `message` listener only after `open` resolves can lose
  // the frame before it ever gets a chance to listen. Making the reply causal
  // — it only exists once the client has asked for it — means the client
  // controls the ordering: by the time it sends `SEAT?` it has necessarily
  // already finished handling `open`, so its listener is already in place.
  // `SEAT?` is idempotent: a repeat (the client's recovery path for a reply it
  // never saw) gets the SAME token again rather than minting a second leg.
  seatWss.on("connection", (client, req) => {
    const url = new URL(req.url ?? "/seat", "http://comms.invalid");
    const surface = url.searchParams.get("surface") ?? "";
    // The surface decides the profile an answered ring is paced at, so a seat
    // without a resolvable one could be rung but never heard.
    if (!resolveLink(config, surface)) { client.close(4400, "unknown surface"); return; }

    let id: string | undefined;
    let token: string | undefined;
    let seatPing: ReturnType<typeof setInterval> | undefined;

    // Counted as pending from the moment the socket connects — see
    // `pendingSeats` above — and released the instant it either mints (folded
    // into `seats.size` instead) or goes away for any other reason.
    // Idempotent so it is safe to call from both the mint path and `drop`.
    pendingSeats += 1;
    let pendingCounted = true;
    const releasePending = () => { if (pendingCounted) { pendingSeats -= 1; pendingCounted = false; } };

    // Mirrors trunkWss's "no register" guard just above: a socket that
    // connects and never completes its handshake (here, SEAT?) would
    // otherwise be held open forever — nothing else ever reaps an un-minted
    // /seat socket. The `id === undefined` check inside the callback guards
    // the same race that guard does: the timer firing essentially the same
    // instant the handshake actually lands.
    const handshakeTimer = setTimeout(() => {
      if (id === undefined) client.close(4408, "no seat handshake");
    }, opts.seats?.handshakeTimeoutMs ?? 20_000);

    const drop = () => {
      clearTimeout(handshakeTimer);
      releasePending();
      if (seatPing) clearInterval(seatPing);
      if (id !== undefined) {
        // Two notifications, because the registry only owns one of them.
        // `close()` tells a PENDING ring its seat is gone (it fires
        // `timedOut`); an ANSWERED call has no such notification, and the
        // machine on the other end would otherwise hold a channel to a
        // departed seat until its own timeout. The bridge owns that wire, so
        // it ends it — a no-op if the ring above already did.
        seats.close(id);
        endSeatCall(id, "seat gone");
      }
    };
    client.on("close", drop);
    client.on("error", drop);

    client.on("message", (data) => {
      let e: Envelope;
      try { e = decodeEnvelope(data.toString()); } catch { return; }

      if (e.kind === "control" && e.payload === "SEAT?") {
        if (id !== undefined) {
          // Already minted for this socket — resend the same token rather
          // than opening a second leg. `token` is set in the same assignment
          // as `id` below, so it is always defined here.
          client.send(encodeEnvelope({
            v: 1, session: id, seq: 0, kind: "control", link: "seat",
            payload: `SEAT ${token}`, eom: true,
          }));
          return;
        }
        clearTimeout(handshakeTimer); // the handshake has arrived, one way or another
        // Checked immediately before the mint it guards, in the same
        // synchronous handler, and against the PENDING count too — a socket
        // that has connected but not yet minted still holds a slot, so a
        // burst of un-minted connections cannot all read the same stale
        // count and pass before any of them actually registers.
        if (seats.size + pendingSeats > (opts.seats?.maxSeats ?? 512)) {
          client.close(4429, "too many seats");
          return;
        }
        releasePending(); // about to become a real leg, counted via seats.size instead
        try {
          ({ id, token } = seats.open(
            { send: (d) => { if (client.readyState === WebSocket.OPEN) client.send(d); },
              close: (code, reason) => client.close(code, reason) },
            surface));
        } catch (err) {
          // seats.ts treats an id/token collision as a capability escape, not
          // an ordinary failure — it must not vanish into a bare close. Log
          // enough to identify which case this was (the message itself never
          // contains the colliding id or token value — see seats.ts).
          console.error(`seat: open() failed for surface "${surface}":`,
                        err instanceof Error ? err.message : err);
          client.close(1011, "seat registry error");
          return;
        }
        seatPing = setInterval(() => {
          if (client.readyState === WebSocket.OPEN) client.ping();
        }, opts.trunk?.relayPingMs ?? 30_000);
        return;
      }

      if (id === undefined) return; // no leg minted yet: nothing else applies
      if (e.kind === "control") {
        if (e.payload === "ANSWER") seats.answer(id);
        else if (e.payload === "REJECT") seats.reject(id);
        // Every other control payload STOPS HERE. Control is this leg's own
        // vocabulary — the words the hub and the terminal say to each other
        // about the line itself — and forwarding it would let a visitor
        // inject NO CARRIER, DIAL, or any other line-state word straight into
        // a machine's stream.
        return;
      }
      // Everything else is conversation, not control of the leg: it goes to
      // the machine this seat answered, byte for byte — the hub never inspects
      // a payload. A seat on no machine call has nowhere to send, and what it
      // types here goes nowhere rather than to whoever it last spoke to.
      seats.inboundOf(id)?.(data.toString());
    });
  });

  relayWss.on("connection", (client, req) => {
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
    // An unknown or dead token is ignored, not fatal: the dial proceeds as an
    // anonymous visitor, no handle is minted, and nothing is said about it — a
    // stale browser tab must still be able to phone a machine.
    //
    // Only mint against a code the switchboard actually holds live. `/x/
    // [A-Z2-9]{6}/link` upgrades are not rate-limited, and mint() keys its
    // per-seat handle map on `code` — minting ahead of openChannel, the way
    // this used to work, let one seat token accumulate an unbounded number of
    // handle entries for the life of the seat just by dialling distinct
    // codes that were never going anywhere (openChannel would refuse every
    // one of them "offline", after the handle already existed). Checking
    // isLive first bounds that to the number of exchanges that actually
    // exist. A live exchange can still refuse the OPEN itself (busy/oversize)
    // after the mint — that residual case is bounded by the same live-
    // exchange count, not by how many codes a caller can type.
    let handle: string | undefined;
    if (seatToken !== null && switchboard.isLive(code)) {
      try {
        handle = seats.mint(seatToken, code);
      } catch (err) {
        // mint() treats a handle collision as a capability escape, not an
        // ordinary failure (see seats.ts) — it must not vanish into a bare
        // close. Same shape as seatWss's open() catch just above.
        console.error(`seat: mint() failed for exchange "${code}":`,
                      err instanceof Error ? err.message : err);
        client.close(1011, "seat registry error");
        return;
      }
    }
    const chan = switchboard.openChannel(code, client, params.toString(),
                                         handle ? { seat: handle } : undefined);
    if (typeof chan !== "number") {
      // Distinct signals: an unknown/offline code is not the same call
      // experience as a live exchange with every channel in use.
      if (chan === "busy") client.close(4429, "exchange busy");
      else if (chan === "oversize") client.close(1009, "query too long");
      else client.close(4404, "exchange offline");
      return;
    }
    // Same rationale as the /link keepalive above (D3): a relayed visitor has
    // no direct upstream socket to piggyback pings on, but it can still sit
    // idle through an authentic-mode reply past a tunnel's idle timeout, so
    // ping it on the same cadence directly.
    const relayPing = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) client.ping();
    }, opts.trunk?.relayPingMs ?? 30_000);
    const seatId = seatToken === null ? undefined : seats.byToken(seatToken)?.id;
    if (seatId) seats.hold(seatId);
    const cleanup = () => {
      clearInterval(relayPing);
      if (seatId) seats.release(seatId);
      switchboard.closeChannel(code, chan);
    };
    client.on("message", (data) => switchboard.clientFrame(code, chan, data.toString()));
    client.on("close", cleanup);
    client.on("error", cleanup);
  });

  const trunkPing = setInterval(() => switchboard.sweepDead(),
                                opts.trunk?.pingIntervalMs ?? 30_000);

  // Every seeded slot gets its port at startup, once the hub knows its own
  // address — the WOPR reference is kept so POST /trunk/place can attach the
  // placer's own local leg after a successful placeCall (Switchboard.placeCall
  // sends an OPEN only to the target; the placer's end is an internal
  // peerPort with nothing to talk to a program otherwise).
  let woprPort: (TrunkPort & { attach(chan: number): void }) | undefined;

  /** Body reader for the routes below — NOT the `/x/<code>` REST relay just
   *  above, which reads inline for a reason specific to it (relaying, not
   *  parsing, so it forwards the raw bytes rather than JSON.parse-ing them).
   *  Same two guards as that reader, so a route below gets the same safety:
   *  capped at 4096 bytes (413, not unbounded buffering), and an aborting
   *  client answered rather than left to escape as an unhandled rejection —
   *  handleHttp is fired as `void handleHttp(req, res)`, so a rejection here
   *  would take down the whole hub process, the one that also serves
   *  production `/link`. Returns undefined once a response has already been
   *  sent (413 or 400); the caller must return immediately in that case. */
  async function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | undefined> {
    const chunks: Buffer[] = [];
    try {
      for await (const c of req) {
        chunks.push(c as Buffer);
        if (Buffer.concat(chunks).length > 4096) { res.writeHead(413); res.end(); return undefined; }
      }
    } catch {
      if (!res.headersSent && res.writable) { res.writeHead(400); res.end(); }
      return undefined;
    }
    return chunks.length ? Buffer.concat(chunks).toString() : "";
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://comms.invalid");
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    if (req.method === "GET" && url.pathname === "/trunk/directory") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ worlds: switchboard.directory(publicBase) }));
      return;
    }
    const m = url.pathname.match(/^\/x\/([A-Z2-9]{6})(\/.*)$/);
    if (m && restAllowed(req.method ?? "", m[2])) {
      // The body read is guarded: a visitor aborting mid-upload errors the
      // request stream, and since handleHttp is fired as `void handleHttp(...)`
      // an escaping rejection here would take down the whole hub process.
      const chunks: Buffer[] = [];
      try {
        for await (const c of req) {
          chunks.push(c as Buffer);
          if (Buffer.concat(chunks).length > 4096) { res.writeHead(413); res.end(); return; }
        }
      } catch {
        // Client aborted / connection reset. Respond only if the socket can
        // still take it; otherwise abandon quietly.
        if (!res.headersSent && res.writable) { res.writeHead(400); res.end(); }
        return;
      }
      const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
      try {
        const out = await switchboard.request(m[1], req.method ?? "GET", m[2], body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(out.body);
      } catch (e) {
        // "offline" = unknown/never-registered code (404); "timeout" = the
        // host never answered (504); anything else — including a mid-flight
        // "dropped" — is a live-but-failed relay leg (502).
        res.writeHead(e === "offline" ? 404 : e === "timeout" ? 504 : 502);
        res.end();
      }
      return;
    }
    // The seam between "a program wanted something" and "a call was placed".
    // A seeded slot has no trunk socket to send a PLACE down, so piece D's
    // node host reaches the switchboard through here instead.
    if (req.method === "POST" && url.pathname === "/trunk/place") {
      // Fail closed: an unconfigured hub (no BRIDGE_INTERNAL_TOKEN/opts
      // token) must not let a bare, unauthenticated CORS-simple POST reach
      // the switchboard. 404, not 401 or 503 — an unconfigured hub does not
      // even advertise that this route exists.
      if (!internalToken) { res.writeHead(404); res.end(); return; }
      if (req.headers["x-wopr-internal-token"] !== internalToken) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = await readBody(req, res);
      if (body === undefined) return; // readBody already answered (413/400)
      let want: { slot?: string; world?: number; seat?: string; on?: number };
      try {
        const parsed: unknown = JSON.parse(body || "{}");
        // JSON.parse("null") succeeds, and `null` is falsy but still passes
        // a bare `!parsed` truthiness check for other falsy JSON values too
        // (0, "", false) — all rejected here as "not a placement request",
        // which they are not. Without this, `want.seat` below throws a
        // TypeError OUTSIDE this try, escaping as an unhandled rejection
        // (handleHttp is fired `void`) and killing the hub process.
        if (!parsed || typeof parsed !== "object") throw new Error("bad body");
        want = parsed as typeof want;
      } catch {
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
      // The one-hop depth cap lives entirely in Switchboard.placeCall's
      // `from.originated.has(on)` check, which only fires when `on` is a
      // real chan number. A non-number here (bad JSON, a client typo) must
      // not silently pass through as some other type Set.has() would just
      // say "no" to — coerce to the one shape the check understands.
      const on = typeof want.on === "number" ? want.on : undefined;
      const r = switchboard.placeCall(from, target as CallTarget, on);
      if (typeof r === "string") {
        res.writeHead(409, { "content-type": "application/json" });
        res.end(JSON.stringify({ refused: r }));
      } else {
        // The target got its OPEN from placeCall itself; the placer's own end
        // is an internal peerPort with no program on the other side of it —
        // attach() is what gives the flagship's own line something to talk
        // with.
        woprPort?.attach(r.chan);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ chan: r.chan }));
      }
      return;
    }
    res.writeHead(404);
    res.end();
  }

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const actualPort = (httpServer.address() as { port: number }).port;
  if (!publicBase) publicBase = `http://localhost:${actualPort}`;

  // Every seeded world-1 slot becomes a real, callable exchange only once the
  // hub knows the address it can dial itself back on — hence this runs after
  // listen(), against actualPort rather than the pre-listen `port` (which is
  // 0 whenever the caller asked for an ephemeral port, as every test here
  // does).
  const commsUrl = `ws://127.0.0.1:${actualPort}`;
  const seededPorts: Array<TrunkPort & { attach(chan: number): void }> = [];
  for (const seed of trunkLocalWorld) {
    const code = switchboard.seededCode(seed.slot);
    if (!code) continue;
    const p = seededPort(seed, bridgeUrl, commsUrl, (f) => switchboard.handleHostFrame(code, f));
    switchboard.seedPort(seed.slot, p);
    seededPorts.push(p);
    if (seed.slot === "WOPR") woprPort = p;
  }

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(trunkPing);
        // A seeded slot's local legs (and any in-flight mint) are this
        // process's own bridge sessions — close them, or a test's next
        // server start can race a lingering /link dial against a stub bridge
        // that already went away.
        for (const p of seededPorts) p.close();
        for (const s of [linkWss, trunkWss, relayWss, seatWss]) for (const c of s.clients) c.terminate();
        httpServer.close(() => resolve());
      }),
  };
}
