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
         type CallTarget, type LocalSlot, type TrunkFrame, type TrunkPort } from "./trunk.ts";
import { openLocalLeg, type LocalLeg } from "./local-leg.ts";

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
}

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
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
  const switchboard = new Switchboard({
    ...opts.trunk,
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

  httpServer.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://comms.invalid").pathname;
    const target = path === "/link" ? linkWss
      : path === "/trunk" ? trunkWss
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

    // One shaper per direction; seq is monotonic per direction (§5).
    const down = new LinkShaper(profile, linkName, session, (e: Envelope) => {
      if (client.readyState === WebSocket.OPEN) client.send(encodeEnvelope(e));
    });

    let upstream: WebSocket | null = null;
    let up: LinkShaper | null = null;
    const upstreamBuffer: Envelope[] = [];
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

  relayWss.on("connection", (client, req) => {
    const url = new URL(req.url ?? "/", "http://comms.invalid");
    const code = url.pathname.split("/")[2];
    const chan = switchboard.openChannel(code, client, url.search.slice(1));
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
    const cleanup = () => {
      clearInterval(relayPing);
      switchboard.closeChannel(code, chan);
    };
    client.on("message", (data) => switchboard.clientFrame(code, chan, data.toString()));
    client.on("close", cleanup);
    client.on("error", cleanup);
  });

  const trunkPing = setInterval(() => switchboard.sweepDead(),
                                opts.trunk?.pingIntervalMs ?? 30_000);

  /** A seeded world-1 slot's "host". It speaks the same TrunkFrame the
   *  switchboard sends down a real trunk socket, but instead of a socket it
   *  opens a local leg against the hub's own bridge. That is the whole trick:
   *  the flagship becomes callable without a trunk back to itself.
   *
   *  `attach` is the placing half of the same trick: a call THIS seed places
   *  (via POST /trunk/place) gets an internal `peerPort` from the switchboard,
   *  not an OPEN — so nothing ever mints a local leg for the placer's end
   *  unless something calls attach() for it. The route below does, right
   *  after a successful placeCall. */
  function seededPort(seed: LocalSlot, code: string, commsUrl: string):
      TrunkPort & { attach(chan: number): void } {
    const legs = new Map<number, LocalLeg>();
    // A machine call's leg is minted asynchronously (a session POST, then a
    // dial) — a CLOSE for that chan can arrive before the mint resolves, and
    // `legs` has no entry yet for the CLOSE handler to find. This registry
    // remembers a canceller per in-flight mint, mirroring tieline.ts's
    // pendingLegs: the leg that eventually resolves finds out it was
    // abandoned instead of silently resurrecting a channel nothing will ever
    // close again.
    const pendingLegs = new Map<number, () => void>();
    const up = (f: TrunkFrame) => switchboard.handleHostFrame(code, f);
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
        if (leg === "refused") return;
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

  // Every seeded slot gets its port at startup, once the hub knows its own
  // address — the WOPR reference is kept so POST /trunk/place can attach the
  // placer's own local leg after a successful placeCall (Switchboard.placeCall
  // sends an OPEN only to the target; the placer's end is an internal
  // peerPort with nothing to talk to a program otherwise).
  let woprPort: (TrunkPort & { attach(chan: number): void }) | undefined;

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", () => resolve(""));
    });
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
    const p = seededPort(seed, code, commsUrl);
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
        for (const s of [linkWss, trunkWss, relayWss]) for (const c of s.clients) c.terminate();
        httpServer.close(() => resolve());
      }),
  };
}
