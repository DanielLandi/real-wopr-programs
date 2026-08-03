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
import { Switchboard, decodeTrunkFrame, restAllowed, TRUNK_MAX_FRAME_BYTES } from "./trunk.ts";

export interface ServerOpts {
  port?: number;
  bridgeUrl?: string;
  internalToken?: string;
  config?: CommsConfig;
  handshake?: HandshakeOpts;
  publicBase?: string;
  trunk?: {
    maxExchanges?: number;
    maxChannels?: number;
    maxWorlds?: number;
    reservedWorlds?: number[];
    reserveKey?: string;
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
  const switchboard = new Switchboard({
    ...opts.trunk,
    maxWorlds: opts.trunk?.maxWorlds ?? defaultMaxWorlds,
    reservedWorlds: opts.trunk?.reservedWorlds ?? defaultReservedWorlds,
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
      upstream.on("close", () => {
        // Deliver NO CARRIER immediately, bypassing baud pacing: teardown()'s
        // down.close() discards anything still in the 300-baud queue, so a
        // shaped send() here would be dropped and the surface would see a bare
        // WS close with no carrier-loss on the line (issue #88).
        down.sendImmediate({ kind: "control", payload: "NO CARRIER" });
        teardown(1000, "upstream closed");
      });
      upstream.on("error", () => {
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
    res.writeHead(404);
    res.end();
  }

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
  const actualPort = (httpServer.address() as { port: number }).port;
  if (!publicBase) publicBase = `http://localhost:${actualPort}`;

  return {
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(trunkPing);
        for (const s of [linkWss, trunkWss, relayWss]) for (const c of s.clients) c.terminate();
        httpServer.close(() => resolve());
      }),
  };
}
