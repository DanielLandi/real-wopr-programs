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
// different handles for the same seat and neither can use the other's. Handles
// travel to machines on the wire (as origin: { seat } in piece B), so handles
// must be cryptographically unpredictable — a hostile federated peer that sees
// a stream of handles must not be able to predict other seats' tokens and
// handles and ring terminals it has never spoken to. Both tokens and handles
// are generated from a CSPRNG and must never use Math.random().
//
// A TOKEN is not a handle. It is the visitor's own name for their own leg,
// travels only to the terminal that owns it, resolves only inside this hub, and
// is never disclosed to any machine. The hub needs one because a terminal mints
// a fresh bridge session per dial, so nothing else correlates a dial to a seat.

import { randomBytes } from "node:crypto";
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
  const bytes = randomBytes(26);
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    // TRUNK_ALPHABET has 32 symbols; 256 % 32 === 0, so byte % TRUNK_ALPHABET.length
    // is uniformly distributed with no bias. If the alphabet length ever changes,
    // this must become rejection sampling or uniform bit slicing.
    s += TRUNK_ALPHABET[bytes[i]! % TRUNK_ALPHABET.length];
  }
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
    // A collision would allow a hostile newId() (injected from server options) to clobber
    // an existing leg while its handleIdx entries still point to it — a capability escape
    // letting one exchange ring a terminal it never spoke to. Throw rather than silently
    // orphaning a leg.
    // Neither message interpolates the id/token value itself: an id is sent
    // to the client as the envelope's `session` field, so it is not this
    // design's secret, but a token is — "never disclosed to any machine"
    // includes never disclosed via a log line either. The collision KIND
    // (this message) plus the caller's surface (logged by server.ts, which
    // catches this) identify the case fully without ever printing a value
    // that must stay confidential.
    if (this.legs.has(id)) throw new Error("seat id collision");
    if (this.byTokenIdx.has(token)) throw new Error("seat token collision");
    this.legs.set(id, { id, surface, port, onCall: false, token, handles: new Map() });
    this.byTokenIdx.set(token, id);
    try {
      this.envelope(id, `SEAT ${token}`);
    } catch (err) {
      // port.send() threw (a hostile or broken SeatPort). The leg and its
      // token index entry were already registered above — leaving them in
      // place would strand a leg whose id never reached the caller, with no
      // way for anyone to close() it: a permanently held token and cap slot.
      // Unregister before propagating.
      this.legs.delete(id);
      this.byTokenIdx.delete(token);
      throw err;
    }
    return { id, token };
  }

  close(id: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    if (leg.ring) {
      const ring = leg.ring;
      ring.cancel();
      leg.ring = undefined;
      // Notify the calling exchange that it got no answer — the seat is gone.
      ring.h.timedOut();
    }
    for (const handle of leg.handles.values()) this.handleIdx.delete(handle);
    this.byTokenIdx.delete(leg.token);
    this.legs.delete(id);
  }

  /** Live seat legs. Callers use this to enforce a cap on concurrent seats —
   *  each is a held-open socket, so unbounded growth is a resource exhaustion. */
  get size(): number { return this.legs.size; }

  byToken(token: string): SeatLeg | undefined {
    const id = this.byTokenIdx.get(token);
    return id === undefined ? undefined : this.legs.get(id);
  }

  leg(id: string): SeatLeg | undefined { return this.legs.get(id); }

  /** This seat is on a call — a dialled one, not only an answered ring — so it
   *  is busy to anyone trying to ring it. */
  hold(id: string): void { const leg = this.legs.get(id); if (leg) leg.onCall = true; }

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

  /** A handle presented by an exchange that did not earn it is refused with
   *  identical value, type, and shape as an unknown one. A machine learns
   *  nothing about seats it has not spoken to — not that they exist, not that
   *  they are online. */
  resolve(handle: string, code: string): SeatLeg | "seat-gone" {
    const entry = this.handleIdx.get(handle);
    if (!entry || entry.code !== code) return "seat-gone";
    return this.legs.get(entry.id) ?? "seat-gone";
  }

  ring(id: string, name: string, h: RingHandlers): "ringing" | "busy" | "seat-gone" {
    const leg = this.legs.get(id);
    if (!leg) return "seat-gone";
    if (leg.ring || leg.onCall) return "busy";
    // Create the ring record with a placeholder cancel, assign it immediately, then arm
    // the timer. This guard against: (1) handler identity confusion when the same
    // handlers object is reused across rings, and (2) race conditions if setTimer fires
    // synchronously. The guard checks ring identity, not handler identity.
    const record: { h: RingHandlers; cancel: () => void } = { h, cancel: () => {} };
    leg.ring = record;
    record.cancel = this.setTimer(this.ringTimeoutMs, () => {
      if (leg.ring !== record) return;   // identity of the RING, not of its handlers
      leg.ring = undefined;
      h.timedOut();
    });
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
