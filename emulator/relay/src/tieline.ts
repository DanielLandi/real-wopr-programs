// The host side of TRUNK/1 (trunk-federation spec): one outbound socket to
// the hub, one local WebSocket per relayed call, an allowlisted local REST
// relay. Runs next to a normal local stack; the hub can only ever reach the
// two configured local endpoints.

import { WebSocket } from "ws";
import { decodeTrunkFrame, restAllowed, type TrunkFrame } from "./trunk.ts";

export interface TielineOpts {
  hubUrl: string;          // wss://wopr.realwopr.ai/trunk
  name: string; region: string; joshua: "claude" | "period"; operator?: string;
  localComms: string;      // ws://127.0.0.1:8081
  localBridge: string;     // http://127.0.0.1:8000
  reconnect?: boolean;     // default true; tests pass false
  onAssigned?: (exchange: string) => void;
}

export function startTieline(opts: TielineOpts): { stop: () => void } {
  let hub: WebSocket | null = null;
  let stopped = false;
  let backoffMs = 5_000;
  const channels = new Map<number, { local: WebSocket; buffer: string[] }>();

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
  }

  function connect(): void {
    if (stopped) return;
    hub = new WebSocket(opts.hubUrl);
    hub.on("open", () => {
      backoffMs = 5_000;
      send({ t: "REGISTER", v: 1, name: opts.name, region: opts.region,
             joshua: opts.joshua, operator: opts.operator });
    });
    hub.on("message", (data) => {
      let f: TrunkFrame;
      try { f = decodeTrunkFrame(data.toString()); } catch { return; }
      if (f.t === "ASSIGNED") opts.onAssigned?.(f.exchange);
      else if (f.t === "OPEN") openChannel(f);
      else if (f.t === "FRAME") {
        const c = channels.get(f.chan);
        if (!c) return;
        if (c.local.readyState === WebSocket.OPEN) c.local.send(f.data);
        else c.buffer.push(f.data);
      } else if (f.t === "CLOSE") { channels.get(f.chan)?.local.close(); channels.delete(f.chan); }
      else if (f.t === "REQUEST") void handleRequest(f);
      else if (f.t === "PING") send({ t: "PONG" });
    });
    const retry = () => {
      for (const c of channels.values()) c.local.close();
      channels.clear();
      if (stopped || opts.reconnect === false) return;
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    };
    hub.on("close", retry);
    hub.on("error", (err) => {
      // close fires after error and drives the reconnect; without this line a
      // refused/reset hub connection is invisible to the operator.
      console.error(`TIE LINE DOWN, RETRYING — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  connect();
  return { stop: () => { stopped = true; hub?.close(); for (const c of channels.values()) c.local.close(); } };
}

// CLI entry: `npm run tieline` on a host machine.
if (import.meta.url === `file://${process.argv[1]}`) {
  startTieline({
    hubUrl: process.env.TRUNK_HUB_URL ?? "wss://wopr.realwopr.ai/trunk",
    name: process.env.TIELINE_NAME ?? "UNNAMED EXCH",
    region: process.env.TIELINE_REGION ?? "SOMEWHERE",
    joshua: (process.env.TIELINE_JOSHUA as "claude" | "period") ?? "period",
    operator: process.env.TIELINE_OPERATOR,
    localComms: process.env.TIELINE_LOCAL_COMMS ?? "ws://127.0.0.1:8081",
    localBridge: process.env.TIELINE_LOCAL_BRIDGE ?? "http://127.0.0.1:8000",
    onAssigned: (exchange) => {
      console.log(`TIE LINE UP — EXCHANGE ${exchange} — LISTED IN THE DIRECTORY`);
      console.log(`share: https://realwopr.ai/war-room.html?exch=${exchange}`);
    },
  });
}
