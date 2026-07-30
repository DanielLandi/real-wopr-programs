// Frame handling for the NORAD terminal, extracted from page.tsx so it is
// testable without a DOM (real-wopr#123). Same shape as home-terminal's
// frames.ts but deliberately a per-surface copy: surface apps stay
// self-contained and share only the wire contract. Pure state machine — no
// React, no DOM, no timers; retry *scheduling* is a sink the page owns.

export type Phase = "connecting" | "connected" | "reconnecting" | "down";

/** Structural mirror of the crt-kit link event (spec-level duplicate on
 *  purpose, like link.ts itself): keeping this module free of runtime imports
 *  is what lets bare `node --test` load it. */
export interface LinkFrame {
  kind: "input" | "output" | "control" | "handshake" | "prompt";
  payload: string;
  eom: boolean;
}
export type FrameEvent =
  | { type: "open" }
  | { type: "frame"; frame: LinkFrame }
  | { type: "close" };

/** Everything the handler can do to the page. The page maps these onto React
 *  state, its refs and its timers; a test maps them onto a plain recorder. */
export interface NoradFrameSinks {
  /** True once the console unmounted; a close must then do nothing. */
  isDisposed(): boolean;
  setPhase(p: Phase): void;
  /** Append a chunk starting on a fresh line (the console's status notices). */
  appendLine(s: string): void;
  /** Raw append — streamed output. */
  appendRaw(s: string): void;
  setPrompt(p: string): void;
  /** WS-close retry: reconnect the link after the console's backoff. */
  scheduleReconnect(): void;
  /** Handshake NO_CARRIER/BUSY retry: send a control DIAL after the backoff. */
  scheduleRedial(): void;
  /** A live handshake also clears the 404-recovery budget the poll owns. */
  resetRecoveries(): void;
}

export class NoradFrameHandler {
  private readonly sinks: NoradFrameSinks;
  private promptBuf = "";
  private handshakeBuf = "";
  private reconnects = 0;

  constructor(sinks: NoradFrameSinks) {
    this.sinks = sinks;
  }

  /** A line drop between a prompt's or handshake's first and last chunk on
   *  the old link strands a fragment that would otherwise prefix the new
   *  link's first one (self-correcting on the next turn, but wrong until
   *  then — and here a leaked prefix could make a later handshake's
   *  includes("CONNECTED") match early or not at all). Called by
   *  connectLink() right before a new WoprLink is constructed. */
  resetLink(): void {
    this.promptBuf = "";
    this.handshakeBuf = "";
  }

  onEvent(e: FrameEvent): void {
    if (e.type === "close") {
      if (this.sinks.isDisposed()) return;
      if (this.reconnects < 3) {
        this.reconnects += 1;
        this.sinks.setPhase("reconnecting");
        this.sinks.appendLine("LINK INTERRUPT - RESYNCHRONIZING\n");
        this.sinks.scheduleReconnect();
      } else {
        this.sinks.setPhase("down");
      }
      return;
    }
    if (e.type !== "frame") return;
    const f = e.frame;
    if (f.kind === "handshake") {
      // Handshake payloads may arrive chunked; reassemble per message before
      // testing its content — inert at leased-9600's wide quantum, but
      // COMMS_BAUD can override any profile, and a test against a single
      // frame's payload would only ever see the last quantum (the same class
      // of bug the prompt frame had, fixed in home-terminal).
      this.handshakeBuf += f.payload;
      if (!f.eom) return;
      const msg = this.handshakeBuf;
      this.handshakeBuf = "";
      if (msg.includes("CONNECTED")) {
        // A live handshake means the (re)connect — including a post-restart
        // re-mint — took. Clear both retry budgets so future faults start fresh.
        this.reconnects = 0;
        this.sinks.resetRecoveries();
        this.sinks.setPhase("connected");
      } else if (msg.startsWith("NO_CARRIER") || msg.startsWith("BUSY")) {
        // Carrier didn't come up on this (re)connect. The comms layer keeps
        // the line open and waits for a control DIAL retry (comms-protocol
        // §4); without one the console would sit at RESYNC forever.
        if (this.reconnects < 3) {
          this.reconnects += 1;
          this.sinks.setPhase("reconnecting");
          this.sinks.appendLine("CARRIER LOST - RETRYING\n");
          this.sinks.scheduleRedial();
        } else {
          this.sinks.setPhase("down");
        }
      }
      return;
    }
    if (f.kind === "control" && f.payload === "NO CARRIER") {
      this.sinks.appendLine("NO CARRIER\n");
      return;
    }
    if (f.kind === "prompt") {
      // The mode indicator lives on the input line, not in the transcript.
      // Reassemble first: a prompt REPLACES where output appends, so a chunked
      // "[NORAD]>" would land as its last quantum alone. leased-9600's quantum
      // is wide enough today, but COMMS_BAUD overrides every profile.
      this.promptBuf += f.payload;
      if (!f.eom) return;
      const p = this.promptBuf;
      this.promptBuf = "";
      this.sinks.setPrompt(p || "WOPR>");
      return;
    }
    if (f.kind === "output") this.sinks.appendRaw(f.payload);
  }
}
