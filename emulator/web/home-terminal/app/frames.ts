// Frame handling for the home terminal, extracted from page.tsx so it is
// testable without a DOM (real-wopr#123). This is the consumer end of the
// comms layer's wire contract (docs/comms-protocol.md §5): payloads arrive
// chunked into emission quanta — 2 bytes at dialup-300 — and the two shipped
// surface bugs both lived in exactly this logic (a prompt handler that
// replaced instead of reassembling, and accumulate-until-eom buffers that
// survived a redial). Pure state machine: no React, no DOM, no timers. The
// page owns rendering and wires these sinks to its state setters; tests wire
// them to plain recorders and feed realistically shaped frames.

export type Phase = "idle" | "scanning" | "dialing" | "connected" | "no-carrier";

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

/** Everything the handler can do to the page. The page maps these onto React
 *  state setters and the audio/speech peripherals; a test maps them onto a
 *  plain object it can assert against. */
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
      this.sinks.setPrompt(p || ">");
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
      // Mark it so the WS close that the comms layer sends right after this
      // frame does not print a duplicate NO CARRIER (#88).
      this.sawNoCarrierFrame = true;
      this.sinks.appendRaw("\n\nNO CARRIER\n");
      this.sinks.setPhase("no-carrier");
    }
  }
}
