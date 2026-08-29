// Browser-side client for the comms layer's /seat WebSocket — the hub's side
// of "a machine can call this terminal" (docs/comms-protocol.md, spec §2/§6).
// A seat outlives every call the terminal itself makes as a visitor: that is
// the whole point, since it is what lets a callback land after the visitor
// has hung up. Mirrors link.ts's structure and envelope encoding on purpose
// — same listener set, same emit helper, same dependency-free style.

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

  connect(): void {
    const base =
      this.opts.url ??
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/seat`;
    const url = new URL(base);
    url.searchParams.set("surface", this.opts.surface);

    this.ws = new WebSocket(url.toString());
    // The hub sends SEAT <token> only in reply to a client SEAT? — it never
    // volunteers one. Waiting for an unsolicited token gets nothing but the
    // hub's own 4408 after its handshake timer runs out.
    this.ws.onopen = () => this.sendControl("SEAT?");
    this.ws.onclose = () => this.emit({ type: "close" });
    this.ws.onmessage = (ev) => {
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

  /** Close the seat. A closed seat cannot be rung; that is correct and needs
   *  no other cleanup, because the hub reaps the leg and every handle minted
   *  against it. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
