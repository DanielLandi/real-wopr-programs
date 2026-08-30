// Browser-side client for the comms layer's /seat WebSocket — the hub's side
// of "a machine can call this terminal" (docs/comms-protocol.md, spec §2/§6).
// A seat outlives every call the terminal itself makes as a visitor: that is
// the whole point, since it is what lets a callback land after the visitor
// has hung up. It must therefore also outlive its own SOCKET — a tunnel blip
// or an exchange redeploy used to end the seat for the life of the page, and
// silently: the visitor could still dial out and could simply never be rung
// back again (#78). So this client redials, and forgets its token the instant
// the socket goes. Mirrors link.ts's structure and envelope encoding on
// purpose — same listener set, same emit helper, same dependency-free style.

import type { Envelope, FrameKind } from "./link.ts";

export type SeatEvent =
  | { type: "seated"; token: string }
  | { type: "ring"; from: string }
  | { type: "frame"; frame: Envelope }
  | { type: "close" };

export interface WoprSeatOpts {
  /** Base URL of the comms layer, e.g. wss://host/seat (default: relative /seat). */
  url?: string;
  surface: string;
}

/** First redial delay after a seat drops, ms. The same number the NORAD
 *  console's own reconnect starts at (norad-terminal/app/page.tsx) — the two
 *  reconnects should begin at one number, not at two arbitrary ones. */
const RETRY_BASE_MS = 750;
/** Ceiling on the redial interval, ms. It is the INTERVAL that is capped, not
 *  the number of attempts: a seat has no visible state, so "gave up" would be
 *  indistinguishable to a visitor from the defect this backoff exists to fix
 *  (#78). A page left open against a dead exchange costs one failed WebSocket
 *  handshake every half minute. */
const RETRY_MAX_MS = 30_000;

/** Thin, dependency-free wrapper around the /seat handshake: ask for a seat
 *  token, hear a ring, answer or reject it, then carry the call's frames. */
export class WoprSeat {
  private ws: WebSocket | null = null;
  private readonly opts: WoprSeatOpts;
  private listeners = new Set<(e: SeatEvent) => void>();
  private _token: string | undefined;
  // The hub's own name for this leg, read off the `session` field of the
  // SEAT reply. Kept because it — not the token — is what belongs in the
  // envelopes this client sends: the token is the visitor's secret (see the
  // header of relay/src/seats.ts, "travels only to the terminal that owns
  // it… is never disclosed to any machine"), and an envelope sent from a
  // seat can be forwarded verbatim into a foreign exchange once a ring is
  // answered (server.ts's seatWss -> seats.inboundOf -> Switchboard's
  // clientFrame -> FRAME over the trunk). Stamping the token there would
  // hand every peer that rings this terminal the one credential the whole
  // handle design exists to keep away from machines. The hub routes a /seat
  // socket by the socket, never by this field, so the leg id is purely
  // informational on the wire — and an empty string is equally acceptable to
  // decodeEnvelope, which is what the pre-handshake `SEAT?` still carries.
  private legId: string | undefined;
  // Monotonic, mirroring WoprLink's own — the hub sequences every envelope
  // it receives on a given link the same way regardless of which side sent
  // it (link.ts's sendEnvelope).
  private seq = 0;
  // Latched by close(): the page unmounting, which must leave no timer behind
  // and must never redial. connect() clears it, so a seat can be deliberately
  // reopened. Starts latched — nothing is scheduled before the first connect().
  private closed = true;
  private retry: ReturnType<typeof setTimeout> | null = null;
  // Consecutive attempts that have not produced a token. Reset by the SEAT
  // reply, NOT by the socket opening: a socket the hub closes with its 4408
  // handshake timer opens and is not a working seat, and resetting on open
  // would turn that into a 750ms poll forever.
  private attempt = 0;

  constructor(opts: WoprSeatOpts) {
    this.opts = opts;
  }

  get token(): string | undefined {
    return this._token;
  }

  onEvent(fn: (e: SeatEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: SeatEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  /** Open the seat and keep it open for the life of the page. Safe to call
   *  again after close(). */
  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    const base =
      this.opts.url ??
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/seat`;
    const url = new URL(base);
    url.searchParams.set("surface", this.opts.surface);

    const ws = new WebSocket(url.toString());
    this.ws = ws;
    // The hub sends SEAT <token> only in reply to a client SEAT? — it never
    // volunteers one. Waiting for an unsolicited token gets nothing but the
    // hub's own 4408 after its handshake timer runs out. A redial takes this
    // same path: there is no resume verb in the /seat vocabulary, so a seat
    // that comes back comes back as a NEW leg with a NEW token, and anything
    // that caches one across a drop is wrong.
    ws.onopen = () => this.sendControl("SEAT?");
    ws.onclose = () => {
      // A socket a later attempt has already superseded owns nothing.
      if (this.ws !== ws) return;
      this.ws = null;
      // Forget the credential FIRST. page.tsx reads `seat.token` per dial and
      // passes it as ?seat=; a token minted against a leg the hub has now
      // reaped mints nothing, so every later dial would silently keep asking
      // for a capability it can no longer be granted. Undefined is honest: the
      // parameter is omitted and the call is one that cannot be rung back.
      this._token = undefined;
      this.legId = undefined;
      this.seq = 0;
      // Announced even though a redial is already scheduled: reconnecting
      // repairs the SEAT, not the call that was riding it. A visitor mid-ring
      // or on an answered callback must still be returned to the prompt.
      this.emit({ type: "close" });
      this.scheduleReconnect();
    };
    ws.onmessage = (ev) => {
      let frame: Envelope;
      try {
        frame = JSON.parse(String(ev.data)) as Envelope;
      } catch {
        return; // drop malformed frames; the line stays up
      }
      if (!frame || frame.v !== 1 || typeof frame.payload !== "string") return;

      // Only SEAT and RING are this client's own handshake vocabulary —
      // everything else, including every other control payload, is forwarded
      // as a frame, exactly like link.ts forwards every kind without
      // filtering. This matters once a ring is answered: the hub then sends
      // NO CARRIER (a control envelope) down this same socket as the only
      // signal that the call ended (relay/src/server.ts's seatBridge.ring ->
      // playOutAndDrop, which sends it via LinkShaper.sendImmediate before
      // down.close() — the seat's own socket stays open throughout, since a
      // seat must outlive the call). Hardcoding a check for that one payload
      // here would only break again the next time the hub adds a control
      // word; the caller (terminal/src/frames.ts's HomeFrameHandler) is the
      // one that knows what NO CARRIER means.
      if (frame.kind === "control" && frame.payload.startsWith("SEAT ")) {
        this._token = frame.payload.slice("SEAT ".length);
        this.legId = frame.session;
        // A token is the only proof this seat works, so it — and nothing
        // earlier — is what clears the backoff.
        this.attempt = 0;
        this.emit({ type: "seated", token: this._token });
        return;
      }
      if (frame.kind === "control" && frame.payload.startsWith("RING ")) {
        // A name can contain spaces (CHEYENNE MOUNTAIN) — split once.
        this.emit({ type: "ring", from: frame.payload.slice("RING ".length) });
        return;
      }
      this.emit({ type: "frame", frame });
    };
  }

  // Same shape link.ts's own sendEnvelope builds, same monotonic seq — the
  // hub does not care which side of a call sent an envelope, only that each
  // side's own sequence climbs.
  private sendEnvelope(kind: FrameKind, payload: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const env: Envelope = {
      v: 1,
      session: this.legId ?? "",
      seq: this.seq++,
      kind,
      link: "seat",
      payload,
      eom: true,
    };
    ws.send(JSON.stringify(env));
  }

  private sendControl(payload: string): void {
    this.sendEnvelope("control", payload);
  }

  /** Redial after the backoff. 750ms, doubling, held at RETRY_MAX_MS, for as
   *  long as the page lives — the exchange redeploys, and a seat that gives up
   *  is the defect this repairs wearing a different hat. Deliberately without
   *  jitter: the population is a handful of browsers, and a fixed schedule is
   *  one that can be asserted rather than waited on. */
  private scheduleReconnect(): void {
    if (this.closed || this.retry !== null) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.attempt, RETRY_MAX_MS);
    this.attempt += 1;
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.closed) this.open();
    }, delay);
  }

  /** Accept the pending ring. A no-op before a token exists — there is
   *  nothing to answer yet, and the hub ignores it anyway. */
  answer(): void {
    if (this._token === undefined) return;
    this.sendControl("ANSWER");
  }

  /** Decline the pending ring. A no-op before a token exists, same as answer(). */
  reject(): void {
    if (this._token === undefined) return;
    this.sendControl("REJECT");
  }

  /** Send one line of conversation to the machine this seat answered — the
   *  seat's side of WoprLink.sendInput, same envelope shape and seq
   *  handling. A no-op before a token exists, same as answer()/reject():
   *  there is no call to speak into yet. */
  send(text: string): void {
    if (this._token === undefined) return;
    this.sendEnvelope("input", text);
  }

  /** Close the seat for good — the page unmounting. A closed seat cannot be
   *  rung; that is correct and needs no other cleanup, because the hub reaps
   *  the leg and every handle minted against it. Unlike a dropped socket this
   *  does NOT redial, and it cancels one already pending: a torn-down
   *  component must leave no timer behind. */
  close(): void {
    this.closed = true;
    if (this.retry !== null) {
      clearTimeout(this.retry);
      this.retry = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
