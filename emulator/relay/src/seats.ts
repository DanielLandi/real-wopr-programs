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
  for (let i = 0; i < 26; i++) {
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
    this.legs.set(id, { id, surface, port, onCall: false, token, handles: new Map() });
    this.byTokenIdx.set(token, id);
    this.envelope(id, `SEAT ${token}`);
    return { id, token };
  }

  close(id: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.ring?.cancel();
    for (const handle of leg.handles.values()) this.handleIdx.delete(handle);
    this.byTokenIdx.delete(leg.token);
    this.legs.delete(id);
  }

  byToken(token: string): SeatLeg | undefined {
    const id = this.byTokenIdx.get(token);
    return id === undefined ? undefined : this.legs.get(id);
  }

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

  /** A handle presented by an exchange that did not earn it is refused exactly
   *  as an unknown one is. A machine learns nothing about seats it has not
   *  spoken to — not that they exist, not that they are online. */
  resolve(handle: string, code: string): SeatLeg | "seat-gone" {
    const entry = this.handleIdx.get(handle);
    if (!entry || entry.code !== code) return "seat-gone";
    return this.legs.get(entry.id) ?? "seat-gone";
  }

  ring(id: string, name: string, h: RingHandlers): "ringing" | "busy" | "seat-gone" {
    const leg = this.legs.get(id);
    if (!leg) return "seat-gone";
    if (leg.ring || leg.onCall) return "busy";
    const cancel = this.setTimer(this.ringTimeoutMs, () => {
      if (leg.ring?.h !== h) return;
      leg.ring = undefined;
      h.timedOut();
    });
    leg.ring = { h, cancel };
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
