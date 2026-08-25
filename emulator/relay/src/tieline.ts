// The host side of TRUNK/1 (trunk-federation spec): one outbound socket to
// the hub, one local WebSocket per relayed call, an allowlisted local REST
// relay. Runs next to a normal local stack; the hub can only ever reach the
// two configured local endpoints.

import { WebSocket } from "ws";
import {
  ALL_SLOTS, decodeTrunkFrame, restAllowed, type CallOrigin, type CallTarget,
  type RefusedReason, type TrunkFrame,
} from "./trunk.ts";

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
  reconnect?: boolean;     // default true; tests pass false
  onAssigned?: (exchange: string, world: number, slot: string) => void;
  // Fires for every OPEN, inbound (origin present when known) or outbound
  // (the OPEN this host's own place() caused arriving back as a channel).
  onOpen?: (chan: number, origin?: CallOrigin) => void;
}

export function startTieline(opts: TielineOpts): {
  stop: () => void;
  place: (to: CallTarget, on?: number) => Promise<{ chan: number } | RefusedReason>;
  assigned: () => boolean;
} {
  let hub: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 5_000;
  let everAssigned = false;
  const channels = new Map<number, { local: WebSocket; buffer: string[] }>();
  const placing = new Map<number, (r: { chan: number } | RefusedReason) => void>();
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

  function openChannel(f: Extract<TrunkFrame, { t: "OPEN" }>): void {
    const local = new WebSocket(`${opts.localComms}/link?${f.query}`);
    const entry = { local, buffer: [] as string[] };
    channels.set(f.chan, entry);
    local.on("open", () => { for (const d of entry.buffer.splice(0)) local.send(d); });
    local.on("message", (data) => send({ t: "FRAME", chan: f.chan, data: data.toString() }));
    const drop = () => { if (channels.delete(f.chan)) send({ t: "CLOSE", chan: f.chan }); };
    local.on("close", drop);
    local.on("error", drop);
    opts.onOpen?.(f.chan, f.origin);
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
        const c = channels.get(f.chan);
        if (!c) return;
        if (c.local.readyState === WebSocket.OPEN) c.local.send(f.data);
        else c.buffer.push(f.data);
      } else if (f.t === "CLOSE") { channels.get(f.chan)?.local.close(); channels.delete(f.chan); }
      else if (f.t === "REQUEST") void handleRequest(f);
      else if (f.t === "PING") send({ t: "PONG" });
      else if (f.t === "PLACED") { placing.get(f.call)?.({ chan: f.chan }); placing.delete(f.call); }
      else if (f.t === "REFUSED") { placing.get(f.call)?.(f.reason); placing.delete(f.call); }
    });
    const retry = () => {
      for (const c of channels.values()) c.local.close();
      channels.clear();
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
    place(to: CallTarget, on?: number): Promise<{ chan: number } | RefusedReason> {
      // No socket, or one already on its way out: resolve rather than
      // reject, so a caller handles "could not place" in one branch instead
      // of a try/catch plus a branch.
      const h = hub;
      if (!h || h.readyState === WebSocket.CLOSING || h.readyState === WebSocket.CLOSED) {
        return Promise.resolve("offline");
      }
      const dial = (resolve: (r: { chan: number } | RefusedReason) => void) => {
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
