// The web renderer: an xterm on one end of the line (#108 §4).
//
// Sibling of render-tty.ts. Where that one pumps a real TTY for `wopr dial`,
// this one drives an xterm.js terminal in a browser tab — and, like it, knows
// nothing about sockets, frames or timers. A page composes it: frames.ts turns
// arriving link frames into sink calls, this turns sink calls into screen
// writes, and the page owns everything in between.
//
// One screen holds two things: the transcript, which the far end streams into,
// and the input line, which the visitor types into and which always sits at the
// bottom. Keeping both correct while output arrives two bytes at a time is the
// whole job. Output at dialup-300 lands mid-word, so a chunk must continue the
// row it is streaming into rather than start a new one; and the input line has
// to be lifted out of the way and put back for every one of those chunks. This
// module therefore repaints, rather than appends: it remembers the rows it
// painted last, walks back over exactly those, and writes them again. Rows are
// measured against the terminal's width, never assumed to be one, so a wrapped
// transcript line or a long command doesn't strand a copy of the input line in
// the middle of the screen.
//
// There is no import of @xterm/xterm here. The terminal arrives as a
// structural TerminalLike, which keeps this file loadable under bare
// `node --test` and lets the tests drive the real emulator core through
// @xterm/headless.

/** The slice of the xterm API this renderer uses. Both `@xterm/xterm` and
 *  `@xterm/headless` Terminals satisfy it structurally. */
export interface TerminalLike {
  readonly cols: number;
  write(data: string, callback?: () => void): void;
  onData(handler: (data: string) => void): { dispose(): void };
}

/** What a frame handler is allowed to do to the screen. Shaped to match
 *  HomeFrameSinks/NoradFrameSinks so a page can wire one straight to the
 *  other (frames.ts `appendLine` is this `appendText`). */
export interface RendererSinks {
  /** Raw append — streamed output, which arrives mid-line. */
  appendRaw(s: string): void;
  /** Append a chunk that must start on a line of its own. */
  appendText(s: string): void;
  setPrompt(p: string): void;
}

export interface XtermMountOpts {
  term: TerminalLike;
  /** A completed input line (Enter). The input line is already cleared when
   *  this runs, so a page is free to echo the command into the transcript. */
  onLine: (line: string) => void;
  /** Ctrl+C — the period BREAK interrupt (docs/surfaces.md). */
  onBreak?: () => void;
  prompt?: string;
  /** Caps-only period terminal: echo and deliver every line uppercased. */
  uppercase?: boolean;
}

export interface XtermMount {
  /** Feed a frame handler's output here. */
  sinks: RendererSinks;
  setPrompt(p: string): void;
  /** Access codes: echo asterisks, never the characters (NORAD logon). */
  setMask(on: boolean): void;
  /** While false there is no input line on screen and keystrokes are
   *  discarded — the NORAD console before its leased line comes up. */
  setEnabled(on: boolean): void;
  dispose(): void;
}

// Escape sequences a modern keyboard emits for keys a 1983 line editor does
// not have: arrows, function keys, Home/End. Dropped rather than typed.
const ESCAPE_SEQUENCE = /\x1b(?:[[O][0-?]*[ -/]*[@-~]|.)?/g;

export function mountXterm(opts: XtermMountOpts): XtermMount {
  const term = opts.term;
  let prompt = opts.prompt ?? ">";
  let buf = "";
  // The transcript's uncommitted final line — everything since the last
  // newline. It shares the repaint region with the input line because the next
  // chunk of output continues it.
  let tail = "";
  // How many rows above the cursor the repaint region starts. Measured, not
  // counted: the tail and the input line each wrap at the terminal's width.
  let above = 0;
  let mask = false;
  let enabled = true;
  let disposed = false;

  const rowsFor = (s: string) => {
    const cols = term.cols > 0 ? term.cols : 80;
    return Math.max(1, Math.ceil(s.length / cols));
  };

  /** Erase the rows painted last time and write them again, optionally
   *  committing finished transcript lines into the scrollback on the way. */
  const paint = (committed: string[] = []) => {
    let out = "\r";
    if (above > 0) out += `\x1b[${above}A`;
    out += "\x1b[J"; // erase from here to the end of the screen
    for (const line of committed) out += `${line}\r\n`;
    let rows = 0;
    if (tail !== "") {
      out += tail;
      rows += rowsFor(tail);
    }
    if (enabled) {
      if (tail !== "") out += "\r\n";
      const input = `${prompt} ${mask ? "*".repeat(buf.length) : buf}`;
      out += input;
      rows += rowsFor(input);
    }
    above = Math.max(0, rows - 1);
    term.write(out);
  };

  const appendRaw = (s: string) => {
    // The wire carries \n; a stray \r would put the cursor somewhere this
    // renderer does not model, so normalise before anything else.
    const lines = (tail + s.replace(/\r\n/g, "\n").replace(/\r/g, "")).split("\n");
    tail = lines.pop() ?? "";
    paint(lines);
  };

  // Exactly the rule the DOM renderer used: the newline is added only when the
  // transcript is mid-line, so a chunk that already starts a line does not
  // open a blank row above itself.
  const appendText = (s: string) => appendRaw(tail === "" ? s : `\n${s}`);

  const setPrompt = (p: string) => {
    prompt = p;
    paint();
  };

  const data = term.onData((d: string) => {
    if (disposed || !enabled) return;
    for (const ch of d.replace(ESCAPE_SEQUENCE, "")) {
      if (ch === "\x03") {
        opts.onBreak?.();
      } else if (ch === "\r" || ch === "\n") {
        const line = buf;
        buf = "";
        paint(); // clear the input line first, so the page's echo lands under it
        opts.onLine(line);
      } else if (ch === "\x7f" || ch === "\b") {
        if (buf !== "") {
          buf = buf.slice(0, -1);
          paint();
        }
      } else if (ch >= " ") {
        buf += opts.uppercase ? ch.toUpperCase() : ch;
        paint();
      }
    }
  });

  paint();

  return {
    sinks: { appendRaw, appendText, setPrompt },
    setPrompt,
    setMask: (on: boolean) => {
      mask = on;
      paint();
    },
    setEnabled: (on: boolean) => {
      if (on === enabled) return;
      enabled = on;
      if (!on) buf = "";
      paint();
    },
    dispose: () => {
      disposed = true;
      data.dispose();
    },
  };
}
