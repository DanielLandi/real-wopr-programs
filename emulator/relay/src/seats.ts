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
  /** Where this seat's non-control envelopes go while it is on an answered
   *  ring: into the machine that rang it. Set by `attach` when the ring is
   *  answered, cleared by `detach` when that call ends — so a seat that is on
   *  no machine call has nowhere to send, and what it types is dropped rather
   *  than delivered to whoever it happened to speak to last. */
  inbound?: (data: string) => void;
  /** How many independent holders currently keep this seat busy. An answered
   *  ring holds one; a leg that seat has dialled out on holds another — both
   *  can be true at once (a visitor mid-conversation dials a second machine
   *  from the same terminal), and the seat stays busy until every holder has
   *  let go. `onCall` (the public, boolean face of this) is `holds > 0`. */
  holds: number;
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
    this.legs.set(id, { id, surface, port, onCall: false, token, handles: new Map(), holds: 0 });
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
    // No holds bookkeeping needed here regardless of how many holders were
    // outstanding: the leg itself is deleted below, so there is no `onCall`
    // left for a stray release() to observe, correctly or otherwise.
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
   *  is busy to anyone trying to ring it. A COUNTER, not a flag: an answered
   *  ring and a leg that seat has dialled out on can both hold the same seat
   *  at once (a visitor mid-conversation dials a second machine from the same
   *  terminal), and each call to `hold` must be matched by its own call to
   *  `release` — one holder letting go must never clear a flag another holder
   *  is still relying on. */
  hold(id: string): void { const leg = this.legs.get(id); if (leg) { leg.holds += 1; leg.onCall = true; } }

  mint(token: string, code: string): string | undefined {
    const id = this.byTokenIdx.get(token);
    const leg = id === undefined ? undefined : this.legs.get(id);
    if (!leg) return undefined;
    const existing = leg.handles.get(code);
    if (existing !== undefined) return existing;
    const handle = this.newId();
    // A collision would let a hostile newId() (injected from server options)
    // silently overwrite an existing handleIdx entry — the SAME capability
    // escape open() guards against for id/token: a handle that used to name
    // one seat would start naming another, invisibly, while the old holder's
    // handles map still claims it too. Throw before mutating anything, so a
    // collision never leaves a half-updated (handles, handleIdx) pair behind.
    if (this.handleIdx.has(handle)) throw new Error("seat handle collision");
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
    try {
      this.envelope(id, `RING ${name}`);
    } catch {
      // port.send() threw (a hostile or broken SeatPort). This runs inside
      // the hub's `message` handler for the caller's PLACE, so letting it
      // escape is an unhandled exception in the process that also serves
      // production `/link`. Unwind the ring completely instead — disarm the
      // timer and clear `leg.ring` — so a seat whose port cannot even be
      // rung is not left armed and "busy" for the whole ring window, and no
      // half-registered ring survives for `answer`/`reject` to latch onto.
      //
      // "seat-gone" is the honest refusal and the safe one: a port that
      // cannot be written to is a seat that cannot be reached, and the
      // reason is already indistinguishable from an unknown handle.
      //
      // NOTHING from the error is logged. The thrower is the port, so its
      // message is attacker-chosen text that could carry this leg's token —
      // the one thing that must never reach a machine, a log line included.
      record.cancel();
      leg.ring = undefined;
      console.error("seat: RING send failed; the seat's port is unusable");
      return "seat-gone";
    }
    return "ringing";
  }

  answer(id: string): void {
    const leg = this.legs.get(id);
    const ring = leg?.ring;
    if (!leg || !ring) return;
    ring.cancel();
    leg.ring = undefined;
    leg.holds += 1;
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

  /** One holder's call has ended. The seat is ringable again only once every
   *  holder has released — an answered ring and a leg it dialled out on both
   *  hold it, and this must decrement, not clear, so releasing one leaves the
   *  other's hold intact. Never goes negative: an extra release beyond the
   *  legitimate holders is a caller bug, not a reason to make onCall lie. */
  release(id: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.holds = Math.max(0, leg.holds - 1);
    leg.onCall = leg.holds > 0;
  }

  /** Route this seat's non-control envelopes to the machine it is talking to.
   *  The registry never looks at what crosses — it only knows which way. */
  attach(id: string, toMachine: (data: string) => void): void {
    const leg = this.legs.get(id);
    if (leg) leg.inbound = toMachine;
  }

  detach(id: string): void {
    const leg = this.legs.get(id);
    if (leg) leg.inbound = undefined;
  }

  inboundOf(id: string): ((data: string) => void) | undefined {
    return this.legs.get(id)?.inbound;
  }

  private envelope(id: string, payload: string): void {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.port.send(encodeEnvelope({
      v: 1, session: id, seq: 0, kind: "control", link: "seat", payload, eom: true,
    }));
  }
}
