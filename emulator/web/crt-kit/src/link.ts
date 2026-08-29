// Browser-side client for the comms layer's /link WebSocket.
// Speaks the message envelope of docs/comms-protocol.md §5. This is a
// spec-level duplicate of the codec on purpose: surfaces and the comms layer
// are separate modules of the federation and share only the wire contract.

export type FrameKind = "input" | "output" | "control" | "handshake" | "prompt";

export interface Envelope {
  v: 1;
  session: string;
  seq: number;
  kind: FrameKind;
  link: string;
  payload: string;
  eom: boolean;
}

export type LinkEvent =
  | { type: "open" }
  | { type: "frame"; frame: Envelope }
  | { type: "close" };

export interface WoprLinkOpts {
  /** Base URL of the comms layer, e.g. wss://host/link (default: relative /link). */
  url?: string;
  surface: string;
  session: string;
  token?: string;
  /** This terminal's seat token, when it holds one. Presenting it is what
   *  makes the hub mint a capability handle for this visitor and disclose it
   *  to the program (relay/src/server.ts:508). Without it the visitor can
   *  dial out and can never be rung back. */
  seat?: string;
}

/** Thin, dependency-free wrapper: connect, receive envelopes, send inputs. */
export class WoprLink {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly opts: WoprLinkOpts;
  private listeners = new Set<(e: LinkEvent) => void>();

  constructor(opts: WoprLinkOpts) {
    this.opts = opts;
  }

  onEvent(fn: (e: LinkEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: LinkEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  connect(): void {
    const base =
      this.opts.url ??
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/link`;
    const url = new URL(base);
    url.searchParams.set("surface", this.opts.surface);
    url.searchParams.set("session", this.opts.session);
    if (this.opts.token) url.searchParams.set("token", this.opts.token);
    if (this.opts.seat) url.searchParams.set("seat", this.opts.seat);

    this.ws = new WebSocket(url.toString());
    this.ws.onopen = () => this.emit({ type: "open" });
    this.ws.onclose = () => this.emit({ type: "close" });
    this.ws.onmessage = (ev) => {
      try {
        const frame = JSON.parse(String(ev.data)) as Envelope;
        if (frame && frame.v === 1 && typeof frame.payload === "string") {
          this.emit({ type: "frame", frame });
        }
      } catch {
        /* drop malformed frames; the line stays up */
      }
    };
  }

  /** The socket if it is carrying, else null — the one place that decides
   *  what "still a line" means, so isOpen() and sendEnvelope() cannot drift. */
  private openSocket(): WebSocket | null {
    return this.ws && this.ws.readyState === WebSocket.OPEN ? this.ws : null;
  }

  /** Whether this is still a live line: the far end accepted it and the
   *  carrier has not gone away. A caller that keeps a link across calls must
   *  ask before treating one as a line it can act on — a dial retried down a
   *  closed socket is discarded here without an error, which is exactly how a
   *  redial used to stall at DIALING forever (#27). */
  isOpen(): boolean {
    return this.openSocket() !== null;
  }

  private sendEnvelope(kind: FrameKind, payload: string): void {
    const ws = this.openSocket();
    if (!ws) return;
    const env: Envelope = {
      v: 1,
      session: this.opts.session,
      seq: this.seq++,
      kind,
      link: "client",
      payload,
      eom: true,
    };
    ws.send(JSON.stringify(env));
  }

  /** Send one line of user input (a command, a move, or conversation). */
  sendInput(text: string): void {
    this.sendEnvelope("input", text);
  }

  /** Period control signals: BREAK, HANGUP, DIAL (retry after NO CARRIER). */
  sendControl(signal: "BREAK" | "HANGUP" | "DIAL"): void {
    this.sendEnvelope("control", signal);
  }

  hangup(): void {
    this.sendControl("HANGUP");
    this.ws?.close();
    this.ws = null;
  }
}
