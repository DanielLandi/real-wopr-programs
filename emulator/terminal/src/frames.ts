// The shared consumer end of the wire contract — one home for both web
// surfaces (real-wopr#123 → #108 §4).
//
// Payloads arrive chunked into emission quanta — 2 bytes at dialup-300
// (docs/comms-protocol.md §5) — and the two surface bugs that shipped both
// lived in exactly this logic: a prompt handler that replaced instead of
// reassembling, and accumulate-until-eom buffers that survived a redial. When
// each surface carried its own copy, each had to learn that lesson separately;
// now they share the state machine and only the renderer differs.
//
// Pure state machines: no React, no DOM, no timers, no sockets. A page owns
// rendering and wires these sinks to its renderer, its state setters and its
// timers; tests wire them to plain recorders and feed realistically shaped
// frames. The two handlers stay distinct on purpose — the home terminal dials
// and hangs up, the NORAD console holds a leased line and retries — but the
// hazards they defend against are the same, so they live side by side where a
// fix to one is visible from the other.

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

// --- home terminal ---------------------------------------------------------

export type Phase = "idle" | "scanning" | "dialing" | "connected" | "no-carrier" | "ringing";

/** The dial-up FSM states as displayed teletype lines (docs/comms-protocol.md
 *  §4). Surface-local copy of the labels the crt-kit HandshakeView renders —
 *  here the sequence is folded into the single scrollback so it interleaves
 *  correctly with command echoes and session output. */
export const HANDSHAKE_LABELS: Record<string, string> = {
  DIALING: "DIALING...",
  RINGING: "RINGING",
  CARRIER_DETECT: "CARRIER DETECTED",
  HANDSHAKE: "░▒▓ HANDSHAKE ▓▒░",
  NO_CARRIER: "NO CARRIER",
  BUSY: "BUSY",
};

/** Everything the handler can do to the page. The page maps these onto the
 *  terminal mount, React state setters and the audio/speech peripherals; a
 *  test maps them onto a plain object it can assert against. */
export interface HomeFrameSinks {
  /** The live phase, readable synchronously (the page's phaseRef). */
  getPhase(): Phase;
  /** React-setter shape so the close path can keep its functional update. */
  setPhase(p: Phase | ((prev: Phase) => Phase)): void;
  /** Append a complete, newline-terminated chunk, starting on a fresh line
   *  (the page's appendText) — handshake FSM lines and the session banner. */
  appendText(s: string): void;
  /** Raw append — streamed output and carrier-loss notices. */
  appendRaw(s: string): void;
  setPrompt(p: string): void;
  /** Handshake state reached: drive the modem speaker. */
  playModem(state: string): void;
  /** A completed output line, for Web Speech when VOICE is ON. */
  speakLine(line: string): void;
}

export class HomeFrameHandler {
  private readonly sinks: HomeFrameSinks;
  private handshakeBuf = "";
  private promptBuf = "";
  private voiceLine = "";
  // Set when a control NO CARRIER frame has already been printed for this
  // drop, so the WS close that follows it does not print a second NO CARRIER.
  private sawNoCarrierFrame = false;
  // What the input line reads when no carrier owns it: the local console
  // interpreter's own prompt. A dialled system replaces it for the life of
  // the call and carrier loss restores it (#26).
  private readonly restingPrompt = ">";

  constructor(sinks: HomeFrameSinks) {
    this.sinks = sinks;
  }

  /** A fresh dial clears any pending carrier-loss notice from a prior line,
   *  and any prompt or handshake fragment stranded by a drop between a
   *  message's first and last chunk on the old line — otherwise it prefixes
   *  the new line's first one (self-correcting on the next turn, but wrong
   *  until then). */
  resetCall(): void {
    this.sawNoCarrierFrame = false;
    this.promptBuf = "";
    this.handshakeBuf = "";
    this.voiceLine = "";
  }

  onEvent(e: FrameEvent): void {
    if (e.type === "close") {
      // An unexpected carrier loss mid-session must announce itself on the
      // line; the old handler flipped phase silently and left a dead prompt
      // (#88). Skip the print when the comms layer already delivered a
      // control NO CARRIER for this drop (sawNoCarrierFrame), and when the
      // close is our own deliberate hangup (the link is detached first, so
      // this never fires).
      const phase = this.sinks.getPhase();
      const unexpected = phase === "connected" || phase === "dialing";
      if (unexpected && !this.sawNoCarrierFrame) {
        this.sinks.appendRaw("\n\nNO CARRIER\n");
      }
      // The line is gone, so the dialled system's prompt must go with it —
      // otherwise the local console answers under PANAMAC's "READY:" (#26).
      // Gated on `unexpected` for the same reason the announcement is: an
      // idle close is not a carrier loss and owns nothing on the input line.
      if (unexpected) this.sinks.setPrompt(this.restingPrompt);
      this.sawNoCarrierFrame = false;
      this.sinks.setPhase((p) => (p === "connected" || p === "dialing" ? "no-carrier" : p));
      return;
    }
    if (e.type !== "frame") return;
    const f = e.frame;
    if (f.kind === "handshake") {
      // Handshake payloads may arrive chunked; reassemble per message.
      this.handshakeBuf += f.payload;
      if (!f.eom) return;
      const msg = this.handshakeBuf;
      this.handshakeBuf = "";
      const state = msg.split(" ")[0];
      this.sinks.playModem(state);
      if (state === "CONNECTED") {
        this.sinks.appendText(`\n${msg.slice(msg.indexOf(" ") + 1)}\n`);
        this.sinks.setPhase("connected");
      } else {
        this.sinks.appendText(`${HANDSHAKE_LABELS[state] ?? state}\n`);
        if (state === "NO_CARRIER" || state === "BUSY") this.sinks.setPhase("no-carrier");
      }
      return;
    }
    if (f.kind === "prompt") {
      // The mode indicator lives on the input line, not in the transcript.
      // Reassemble first: output frames survive chunking because they append,
      // but a prompt REPLACES, so at dialup-300's two-byte quantum "[TTT]>"
      // would land as "]>" — the last quantum only.
      this.promptBuf += f.payload;
      if (!f.eom) return;
      const p = this.promptBuf;
      this.promptBuf = "";
      this.sinks.setPrompt(p || this.restingPrompt);
      return;
    }
    if (f.kind === "output") {
      // Raw append — payloads stream mid-line, so no fresh-line guard here.
      this.sinks.appendRaw(f.payload);
      this.voiceLine += f.payload;
      const lines = this.voiceLine.split("\n");
      this.voiceLine = lines.pop() ?? "";
      for (const l of lines) this.sinks.speakLine(l);
      return;
    }
    if (f.kind === "control" && f.payload === "NO CARRIER") {
      // One hang-up, one announcement. The flag suppresses the WS close that
      // the comms layer sends right after this frame (#88) — and a repeat of
      // the signal itself, because a drop announced twice is the same defect
      // whether the second one arrives as a close or as another frame (#49).
      // resetCall()/close clear it, so a later call announces again.
      if (this.sawNoCarrierFrame) return;
      this.sawNoCarrierFrame = true;
      this.sinks.appendRaw("\n\nNO CARRIER\n");
      this.sinks.setPrompt(this.restingPrompt);
      this.sinks.setPhase("no-carrier");
    }
  }
}

// --- NORAD console ---------------------------------------------------------

/** The NORAD console's own phase vocabulary. It never dials or scans — it
 *  holds a leased line — so its states are not the home terminal's `Phase`
 *  and the two must not be conflated. */
export type NoradPhase = "connecting" | "connected" | "reconnecting" | "down";

/** Everything the handler can do to the page. The page maps these onto the
 *  terminal mount, React state, its refs and its timers; a test maps them onto
 *  a plain recorder. */
export interface NoradFrameSinks {
  /** True once the console unmounted; a close must then do nothing. */
  isDisposed(): boolean;
  setPhase(p: NoradPhase): void;
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
