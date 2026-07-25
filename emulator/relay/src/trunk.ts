// TRUNK/1 — exchange-to-exchange trunking (trunk-federation spec). The hub is
// a switchboard: it assigns exchange codes, relays call channels and an
// allowlisted REST subset down each trunk, and never inspects relayed payloads.

export type TrunkFrame =
  | { t: "REGISTER"; v: 1; name: string; region: string; joshua: "claude" | "period"; operator?: string }
  | { t: "ASSIGNED"; exchange: string }
  | { t: "OPEN"; chan: number; query: string }
  | { t: "FRAME"; chan: number; data: string }
  | { t: "CLOSE"; chan: number; reason?: string }
  | { t: "REQUEST"; rid: number; method: string; path: string; body?: string }
  | { t: "RESPONSE"; rid: number; status: number; body: string }
  | { t: "PING" }
  | { t: "PONG" };

export const TRUNK_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const TRUNK_MAX_FRAME_BYTES = 8192;

const FRAME_TYPES = new Set(["REGISTER", "ASSIGNED", "OPEN", "FRAME", "CLOSE", "REQUEST", "RESPONSE", "PING", "PONG"]);

export function decodeTrunkFrame(raw: string): TrunkFrame {
  if (Buffer.byteLength(raw) > TRUNK_MAX_FRAME_BYTES) throw new Error("oversize frame");
  const f = JSON.parse(raw) as TrunkFrame;
  if (!f || typeof f !== "object" || !FRAME_TYPES.has((f as { t: string }).t)) throw new Error("unknown frame");
  // Wire-level field-type checks only: `data`/`body` content stays opaque —
  // the switchboard never inspects relayed payloads, it just requires that
  // they arrive as strings so a raw ws send() cannot blow up downstream.
  if (f.t === "REGISTER") {
    if (f.v !== 1) throw new Error("bad version");
    if (typeof f.name !== "string" || f.name.length < 2 || f.name.length > 24) throw new Error("bad name");
    if (typeof f.region !== "string" || f.region.length < 2 || f.region.length > 24) throw new Error("bad region");
    if (f.joshua !== "claude" && f.joshua !== "period") throw new Error("bad joshua");
    if (f.operator !== undefined && (typeof f.operator !== "string" || f.operator.length > 24)) throw new Error("bad operator");
  } else if (f.t === "ASSIGNED") {
    if (typeof f.exchange !== "string") throw new Error("bad exchange");
  } else if (f.t === "OPEN") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    if (typeof f.query !== "string") throw new Error("bad query");
  } else if (f.t === "FRAME") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    if (typeof f.data !== "string") throw new Error("bad data");
  } else if (f.t === "CLOSE") {
    if (!Number.isInteger(f.chan)) throw new Error("bad chan");
    // The reason is relayed verbatim as a ws close reason (<=123 bytes by
    // spec, ws throws above that) — cap it at the wire.
    if (f.reason !== undefined &&
        (typeof f.reason !== "string" || Buffer.byteLength(f.reason) > 100)) throw new Error("bad reason");
  } else if (f.t === "REQUEST") {
    if (!Number.isInteger(f.rid)) throw new Error("bad rid");
    if (typeof f.method !== "string") throw new Error("bad method");
    if (typeof f.path !== "string") throw new Error("bad path");
    if (f.body !== undefined && typeof f.body !== "string") throw new Error("bad body");
  } else if (f.t === "RESPONSE") {
    if (!Number.isInteger(f.rid)) throw new Error("bad rid");
    // The status is fed straight into res.writeHead, which throws outside the
    // HTTP range — a hostile host must not be able to crash the hub with it.
    if (!Number.isInteger(f.status) || f.status < 100 || f.status > 599) throw new Error("bad status");
    if (typeof f.body !== "string") throw new Error("bad body");
  }
  return f;
}

const REST_ALLOWLIST: Array<[string, RegExp]> = [
  ["POST", /^\/api\/session$/],
  ["GET", /^\/api\/session\/[0-9a-f-]{36}$/],
  ["POST", /^\/api\/room$/],
  ["GET", /^\/api\/room\/[A-Z2-9]{6}$/],
  ["GET", /^\/api\/games$/],
  ["GET", /^\/health$/],
];

export function restAllowed(method: string, path: string): boolean {
  return REST_ALLOWLIST.some(([m, re]) => m === method.toUpperCase() && re.test(path));
}

export function newExchangeCode(): string {
  let code = "";
  while (code.length < 6) {
    const ch = TRUNK_ALPHABET[Math.floor(Math.random() * TRUNK_ALPHABET.length)];
    code += ch;
  }
  return code;
}

export interface DirectoryEntry {
  id: string; name: string; region: string; api: string; link: string;
  joshua: string; operator?: string; online: true;
}

// TrunkPort is the minimal socket shape the registry needs (ws WebSocket satisfies it);
// tests pass fakes.
export interface TrunkPort { send(data: string): void; close(code?: number, reason?: string): void; }
export interface ChannelPort extends TrunkPort {}

interface Exchange {
  code: string; name: string; region: string; joshua: string; operator?: string;
  port: TrunkPort;
  channels: Map<number, ChannelPort>;
  nextChan: number;
  pending: Map<number, { resolve: (r: { status: number; body: string }) => void;
                         reject: (e: string) => void; timer: NodeJS.Timeout }>;
  nextRid: number;
  missedPongs: number;
}

export class Switchboard {
  private exchanges = new Map<string, Exchange>();
  private maxExchanges: number;
  private maxChannels: number;

  constructor(opts: { maxExchanges?: number; maxChannels?: number } = {}) {
    this.maxExchanges = opts.maxExchanges ?? 32;
    this.maxChannels = opts.maxChannels ?? 16;
  }

  register(port: TrunkPort, f: Extract<TrunkFrame, { t: "REGISTER" }>): string | null {
    if (this.exchanges.size >= this.maxExchanges) return null;
    let code = newExchangeCode();
    while (this.exchanges.has(code)) code = newExchangeCode();
    this.exchanges.set(code, {
      code, name: f.name.toUpperCase(), region: f.region.toUpperCase(),
      joshua: f.joshua, operator: f.operator, port,
      channels: new Map(), nextChan: 1, pending: new Map(), nextRid: 1, missedPongs: 0,
    });
    return code;
  }

  unregister(code: string): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    this.exchanges.delete(code);
    for (const client of ex.channels.values()) client.close(1001, "trunk dropped");
    // The exchange was live when it accepted these requests: reject them as a
    // mid-flight drop (502 at the relay), not as an unknown code ("offline").
    for (const p of ex.pending.values()) { clearTimeout(p.timer); p.reject("dropped"); }
  }

  openChannel(code: string, client: ChannelPort, query: string): number | "offline" | "busy" | "oversize" {
    const ex = this.exchanges.get(code);
    if (!ex) return "offline";
    if (ex.channels.size >= this.maxChannels) return "busy";
    const chan = ex.nextChan;
    const encoded = JSON.stringify({ t: "OPEN", chan, query });
    // JSON-escaping puts no upper bound on the wrapped query relative to the
    // raw URL: refuse an OPEN the trunk leg could never carry rather than
    // sending a frame the host-side decoder would drop (leaving this end's
    // channel slot half-open forever).
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) return "oversize";
    ex.nextChan += 1;
    ex.channels.set(chan, client);
    ex.port.send(encoded);
    return chan;
  }

  closeChannel(code: string, chan: number): void {
    const ex = this.exchanges.get(code);
    if (!ex || !ex.channels.has(chan)) return;
    ex.channels.delete(chan);
    ex.port.send(JSON.stringify({ t: "CLOSE", chan }));
  }

  clientFrame(code: string, chan: number, data: string): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    const client = ex.channels.get(chan);
    if (!client) return;
    const encoded = JSON.stringify({ t: "FRAME", chan, data });
    // A legal <=8192-byte visitor frame can escape-amplify past the trunk cap
    // once wrapped (every `"` and `\` doubles); the host-side decoder would
    // discard the oversize frame silently. Close the call explicitly on both
    // legs instead of corrupting the stream.
    if (Buffer.byteLength(encoded) > TRUNK_MAX_FRAME_BYTES) {
      ex.channels.delete(chan);
      client.close(1009, "frame exceeds trunk capacity");
      ex.port.send(JSON.stringify({ t: "CLOSE", chan, reason: "oversize frame" }));
      return;
    }
    ex.port.send(encoded);
  }

  handleHostFrame(code: string, f: TrunkFrame): void {
    const ex = this.exchanges.get(code);
    if (!ex) return;
    if (f.t === "FRAME") ex.channels.get(f.chan)?.send(f.data);
    else if (f.t === "CLOSE") {
      // Relay the host's stated reason (decode caps it) instead of discarding it.
      ex.channels.get(f.chan)?.close(1000, f.reason ?? "call ended");
      ex.channels.delete(f.chan);
    }
    else if (f.t === "RESPONSE") {
      const p = ex.pending.get(f.rid);
      if (p) { clearTimeout(p.timer); ex.pending.delete(f.rid); p.resolve({ status: f.status, body: f.body }); }
    } else if (f.t === "PONG") ex.missedPongs = 0;
  }

  request(code: string, method: string, path: string, body: string | undefined,
          timeoutMs = 10_000): Promise<{ status: number; body: string }> {
    const ex = this.exchanges.get(code);
    if (!ex) return Promise.reject("offline");
    const rid = ex.nextRid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ex.pending.delete(rid); reject("timeout"); }, timeoutMs);
      ex.pending.set(rid, { resolve, reject, timer });
      ex.port.send(JSON.stringify({ t: "REQUEST", rid, method, path, body }));
    });
  }

  directory(publicBase: string): DirectoryEntry[] {
    const wsBase = publicBase.replace(/^http/, "ws");
    return [...this.exchanges.values()].map((ex) => ({
      id: `trunk-${ex.code.toLowerCase()}`, name: ex.name, region: ex.region,
      api: `${publicBase}/x/${ex.code}`, link: `${wsBase}/x/${ex.code}/link`,
      joshua: ex.joshua, operator: ex.operator, online: true as const,
    }));
  }

  sweepDead(): string[] {
    const dropped: string[] = [];
    for (const ex of this.exchanges.values()) {
      ex.missedPongs += 1;
      if (ex.missedPongs >= 2) dropped.push(ex.code);
      else ex.port.send(JSON.stringify({ t: "PING" }));
    }
    for (const code of dropped) this.unregister(code);
    return dropped;
  }
}
