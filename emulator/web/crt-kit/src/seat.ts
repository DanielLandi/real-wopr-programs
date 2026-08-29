// Browser-side client for the comms layer's /seat WebSocket — the hub's side
// of "a machine can call this terminal" (docs/comms-protocol.md, spec §2/§6).
// A seat outlives every call the terminal itself makes as a visitor: that is
// the whole point, since it is what lets a callback land after the visitor
// has hung up. Mirrors link.ts's structure and envelope encoding on purpose
// — same listener set, same emit helper, same dependency-free style.

import type { Envelope } from "./link.ts";

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

  private sendControl(payload: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const env: Envelope = {
      v: 1,
      session: this._token ?? "",
      seq: 0,
      kind: "control",
      link: "seat",
      payload,
      eom: true,
    };
    ws.send(JSON.stringify(env));
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

  /** Close the seat. A closed seat cannot be rung; that is correct and needs
   *  no other cleanup, because the hub reaps the leg and every handle minted
   *  against it. */
  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
