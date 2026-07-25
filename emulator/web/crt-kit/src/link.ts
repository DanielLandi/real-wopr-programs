// Browser-side client for the comms layer's /link WebSocket.
// Speaks the message envelope of docs/comms-protocol.md §5. This is a
// spec-level duplicate of the codec on purpose: surfaces and the comms layer
// are separate modules of the federation and share only the wire contract.

export type FrameKind = "input" | "output" | "control" | "handshake";

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

  private sendEnvelope(kind: FrameKind, payload: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const env: Envelope = {
      v: 1,
      session: this.opts.session,
      seq: this.seq++,
      kind,
      link: "client",
      payload,
      eom: true,
    };
    this.ws.send(JSON.stringify(env));
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
