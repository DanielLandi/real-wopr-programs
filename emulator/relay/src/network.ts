// One network, one relay process.
//
// A network is a relay plus an addressing scheme. This module is that relay,
// instantiated from a descriptor the pack declares — so adding `norad` or `bus`
// is a pack.json edit, not engine code. Two legs:
//
//   /node   nodes dial in and claim the lines they answer (NODE/1)
//   /dial   callers dial an address; the relay rings whoever holds that line
//
// Era shaping is applied on the caller's leg using the profile the network's
// kind implies, so a 300-baud dial-up line still feels like one. The relay
// never inspects a payload — it is a wire.

import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { DEFAULT_CONFIG, type CommsMode, type LinkProfile } from "./config.ts";
import { encodeEnvelope, type Envelope } from "./envelope.ts";
import { LinkShaper } from "./shaper.ts";
import {
  decodeNodeFrame, encodeNodeFrame, NODE_MAX_FRAME_BYTES,
  type NodeFrame,
} from "./node-proto.ts";
import { Registry, type Addressing, type NodePort } from "./registry.ts";

export interface NetworkDescriptor {
  name: string;
  kind: "dialup" | "leased" | "local";
  addressing: Addressing;
  baud?: number;
  public?: boolean;
  private?: boolean;
}

export interface NetworkRelayOpts {
  port?: number;
  mode?: CommsMode;
}

export interface RunningNetworkRelay {
  port: number;
  address: string;
  close: () => Promise<void>;
  /** Used by the supervisor once it knows each node's declaration. */
  setCallableBy: (node: string, callableBy: string[] | null) => void;
}

/** Which link profile a network implies: a declared baud picks the matching
 * tuned profile when one exists ("dialup-1200"); otherwise the kind's
 * default. `fast` mode flattens them all. */
export function profileFor(desc: NetworkDescriptor, mode: CommsMode): LinkProfile {
  if (mode === "fast") return DEFAULT_CONFIG.profiles.off;
  const byKind: Record<NetworkDescriptor["kind"], string> = {
    dialup: "dialup-300",
    leased: "leased-9600",
    local: "internal-bus",
  };
  const tuned = desc.baud !== undefined
    ? DEFAULT_CONFIG.profiles[`${desc.kind}-${desc.baud}`]
    : undefined;
  return tuned ?? DEFAULT_CONFIG.profiles[byKind[desc.kind]] ?? DEFAULT_CONFIG.profiles.off;
}

interface Call {
  id: number;
  caller: WebSocket;
  callerName: string;
  node: string;
  answered: boolean;
  shaper: LinkShaper;
}

export async function startNetworkRelay(
  desc: NetworkDescriptor,
  opts: NetworkRelayOpts = {},
): Promise<RunningNetworkRelay> {
  const mode: CommsMode =
    opts.mode ?? ((process.env.COMMS_MODE === "fast") ? "fast" : "authentic");
  const profile = profileFor(desc, mode);
  const registry = new Registry({ [desc.name]: { name: desc.name, addressing: desc.addressing } });

  // A private network is a local channel, not a line anyone can dial: bind
  // loopback so nothing off-box can reach a store even by guessing its name.
  const host = desc.private ? "127.0.0.1" : "0.0.0.0";

  const httpServer: Server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const nodeWss = new WebSocketServer({ noServer: true, maxPayload: NODE_MAX_FRAME_BYTES + 512 });
  const dialWss = new WebSocketServer({ noServer: true, maxPayload: NODE_MAX_FRAME_BYTES });

  const calls = new Map<number, Call>();
  const callsByNode = new Map<string, Set<number>>();
  let nextCall = 1;

  function nodeSocketOf(node: string): WebSocket | null {
    const reg = registry.get(node);
    return reg ? (reg.port as unknown as WebSocket) : null;
  }

  function endCall(id: number, reason: string): void {
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    callsByNode.get(call.node)?.delete(id);
    call.shaper.close();
    try { call.caller.close(1000, reason); } catch { /* already gone */ }
    const sock = nodeSocketOf(call.node);
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(encodeNodeFrame({ t: "CLOSE", call: id, reason }));
    }
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://relay.invalid").pathname;
    const target = path === "/node" ? nodeWss : path === "/dial" ? dialWss : null;
    if (!target) { socket.destroy(); return; }
    target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
  });

  // ---- the node leg: claim lines, answer rings ------------------------------
  nodeWss.on("connection", (ws) => {
    let nodeId: string | null = null;

    ws.on("message", (raw) => {
      let f: NodeFrame;
      try { f = decodeNodeFrame(raw.toString()); }
      catch { ws.close(1002, "bad frame"); return; }

      if (f.t === "REGISTER") {
        const res = registry.claim(f.node, f.claims, ws as unknown as NodePort,
                                   { callableBy: f.callable_by ?? null });
        if (!res.ok) {
          ws.send(encodeNodeFrame({ t: "REJECTED", node: f.node, reason: res.reason ?? "rejected" }));
          return;
        }
        nodeId = f.node;
        callsByNode.set(f.node, callsByNode.get(f.node) ?? new Set());
        ws.send(encodeNodeFrame({ t: "REGISTERED", node: f.node }));
        return;
      }

      if (f.t === "ANSWER") {
        const call = calls.get(f.call);
        if (call && call.node === nodeId) call.answered = true;
        return;
      }

      if (f.t === "FRAME") {
        const call = calls.get(f.call);
        if (!call || call.node !== nodeId) return;
        // Node -> caller, paced by the network's profile.
        call.shaper.send({ kind: "output", payload: f.data });
        return;
      }

      if (f.t === "CLOSE") {
        if (calls.get(f.call)?.node === nodeId) endCall(f.call, f.reason ?? "NO CARRIER");
        return;
      }

      if (f.t === "PING") { ws.send(encodeNodeFrame({ t: "PONG" })); return; }
    });

    ws.on("close", () => {
      if (!nodeId) return;
      for (const id of [...(callsByNode.get(nodeId) ?? [])]) endCall(id, "NO CARRIER");
      callsByNode.delete(nodeId);
      registry.release(nodeId);
    });
  });

  // ---- the caller leg: dial an address -------------------------------------
  dialWss.on("connection", (caller, req) => {
    const url = new URL(req.url ?? "/dial", "http://relay.invalid");
    const address = url.searchParams.get("address") ?? "";
    const from = url.searchParams.get("from") ?? "caller";

    const reg = registry.lookup(desc.name, address);
    // One message for "nobody holds that line" and "you may not reach them":
    // a caller learns nothing about who exists from a dial that fails.
    if (!reg || !registry.permits(from, reg.node)) {
      caller.close(1000, "NO ANSWER");
      return;
    }

    const id = nextCall++;
    const session = `${desc.name}-${id}`;
    const shaper = new LinkShaper(profile, desc.name, session, (e: Envelope) => {
      if (caller.readyState === WebSocket.OPEN) caller.send(encodeEnvelope(e));
    });
    const call: Call = { id, caller, callerName: from, node: reg.node, answered: false, shaper };
    calls.set(id, call);
    callsByNode.get(reg.node)?.add(id);

    (reg.port as unknown as WebSocket).send(encodeNodeFrame({
      t: "RING", call: id, from, network: desc.name, address: registryAddress(address),
    }));

    caller.on("message", (raw) => {
      const sock = nodeSocketOf(call.node);
      if (sock && sock.readyState === WebSocket.OPEN) {
        sock.send(encodeNodeFrame({ t: "FRAME", call: id, data: raw.toString() }));
      }
    });
    caller.on("close", () => {
      if (calls.has(id)) endCall(id, "CALLER HUNG UP");
    });
  });

  function registryAddress(address: string): string {
    // Hand the node the normalized form, so it sees the same line identity the
    // registry routed on rather than however the caller punctuated it.
    return desc.addressing === "phone"
      ? address.replace(/\D/g, "")
      : address.trim().toUpperCase();
  }

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, host, () => resolve()));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    port,
    address: host,
    setCallableBy(node, callableBy) {
      const reg = registry.get(node);
      if (reg) reg.callableBy = callableBy;
    },
    close: async () => {
      for (const id of [...calls.keys()]) endCall(id, "RELAY DOWN");
      await new Promise<void>((resolve) => { nodeWss.close(() => resolve()); });
      await new Promise<void>((resolve) => { dialWss.close(() => resolve()); });
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    },
  };
}
