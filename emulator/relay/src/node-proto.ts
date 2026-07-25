// NODE/1 — how a node claims the lines it answers, and how calls reach it.
//
// A node dials its relay *outbound* and registers its addresses; calls are then
// carried back down that same socket. Relays are therefore the only listeners,
// so nothing has to allocate or discover a node's port, and a node can be
// hand-run against a relay started separately.
//
// Electrically a 1983 subscriber's modem answered an incoming ring — but the
// exchange already knew which line was whose, because of the wire pair in the
// frame room. Outbound registration models the frame room; the ring, carrier
// and handshake are then simulated over that channel, so what the caller
// observes is unchanged.
//
// Sibling to trunk.ts, which does the same job for exchange-to-exchange
// trunking. As there: wire-level field-type checks only. `data` stays opaque —
// the relay is a wire and never inspects what it carries.

export interface AddressClaim {
  network: string;
  address: string;
  protocol: string;
}

export type NodeFrame =
  // node -> relay
  | { t: "REGISTER"; v: 1; node: string; claims: AddressClaim[] }
  | { t: "ANSWER"; call: number }
  | { t: "DIAL"; call: number; network: string; address: string }
  // relay -> node
  | { t: "REGISTERED"; node: string }
  | { t: "REJECTED"; node: string; reason: string }
  | { t: "RING"; call: number; from: string; network: string; address: string }
  // either direction
  | { t: "FRAME"; call: number; data: string }
  | { t: "CLOSE"; call: number; reason?: string }
  | { t: "PING" }
  | { t: "PONG" };

export const NODE_MAX_FRAME_BYTES = 8192;

const FRAME_TYPES = new Set([
  "REGISTER", "REGISTERED", "REJECTED", "RING", "ANSWER",
  "FRAME", "CLOSE", "DIAL", "PING", "PONG",
]);

function requireCall(f: { call?: unknown }): void {
  if (!Number.isInteger(f.call)) throw new Error("bad call id");
}

function requireName(v: unknown, what: string): void {
  if (typeof v !== "string" || v.length < 1 || v.length > 64) {
    throw new Error(`bad ${what}`);
  }
}

export function encodeNodeFrame(f: NodeFrame): string {
  return JSON.stringify(f);
}

export function decodeNodeFrame(raw: string): NodeFrame {
  if (Buffer.byteLength(raw) > NODE_MAX_FRAME_BYTES) throw new Error("oversize frame");
  const f = JSON.parse(raw) as NodeFrame;
  if (!f || typeof f !== "object" || !FRAME_TYPES.has((f as { t: string }).t)) {
    throw new Error("unknown frame");
  }

  if (f.t === "REGISTER") {
    if (f.v !== 1) throw new Error("bad version");
    requireName(f.node, "node");
    if (!Array.isArray(f.claims) || f.claims.length === 0) {
      throw new Error("a REGISTER needs at least one claim");
    }
    for (const c of f.claims) {
      if (!c || typeof c !== "object") throw new Error("bad claim");
      requireName(c.network, "claim network");
      // Addresses are formatted for humans ("(206) 555-0142"); the registry
      // normalizes per the network's addressing scheme, not here.
      if (typeof c.address !== "string" || c.address.trim().length === 0) {
        throw new Error("bad claim address");
      }
      requireName(c.protocol, "claim protocol");
    }
  } else if (f.t === "REGISTERED") {
    requireName(f.node, "node");
  } else if (f.t === "REJECTED") {
    requireName(f.node, "node");
    if (typeof f.reason !== "string") throw new Error("bad reason");
  } else if (f.t === "RING") {
    requireCall(f);
    requireName(f.from, "from");
    requireName(f.network, "network");
    if (typeof f.address !== "string") throw new Error("bad address");
  } else if (f.t === "ANSWER") {
    requireCall(f);
  } else if (f.t === "DIAL") {
    requireCall(f);
    requireName(f.network, "network");
    if (typeof f.address !== "string") throw new Error("bad address");
  } else if (f.t === "FRAME") {
    requireCall(f);
    // Type-checked, never inspected: a raw ws send() must not be able to blow
    // up downstream, but what the payload *means* is between the two programs.
    if (typeof f.data !== "string") throw new Error("bad data");
  } else if (f.t === "CLOSE") {
    requireCall(f);
    // Relayed verbatim as a ws close reason (<=123 bytes by spec, ws throws
    // above that) — cap it at the wire, as TRUNK/1 does.
    if (f.reason !== undefined &&
        (typeof f.reason !== "string" || Buffer.byteLength(f.reason) > 100)) {
      throw new Error("bad reason");
    }
  }
  return f;
}
