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
// A line typed at a prompt is recorded as it looked: Enter leaves the prompt and
// the text in the transcript ("SELECT: LIST"), with a secret prompt's answer
// as stars, so the pages never write an echo of their own. And once a line has
// gone to the far end, the input line is held off the screen until the reply
// is over — the cursor rides the end of the streaming text, as on a terminal,
// instead of an input line under it still showing the previous question.
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

/** setTimeout/clearTimeout, injectable so a test decides when they fire. */
export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface XtermMountOpts {
  term: TerminalLike;
  /** A completed input line (Enter). The renderer has already recorded it in
   *  the transcript as `echo` — the prompt and the line, starred if the prompt
   *  was secret — so a page writes no echo of its own. `echo` is handed over
   *  for pages that keep a text mirror of the screen. */
  onLine: (line: string, echo: string) => void;
  /** Ctrl+C — the period BREAK interrupt (docs/surfaces.md). */
  onBreak?: () => void;
  prompt?: string;
  /** Caps-only period terminal: echo and deliver every line uppercased. */
  uppercase?: boolean;
  /** Defaults to the global setTimeout/clearTimeout. */
  timers?: Timers;
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
  /** The far end is answering: take the input line off the screen until it
   *  asks again. A prompt ends the hold; so does output going quiet for
   *  QUIET_MS, and so does nothing arriving at all for CEILING_MS — a turn
   *  is not obliged to send a prompt. Keys typed meanwhile are kept, and a
   *  line entered meanwhile answers the next prompt. */
  hold(): void;
  /** End a hold the page started for work of its own (a scan, a dial). */
  release(): void;
  dispose(): void;
}

/** A prompt that asks for a secret: its answer is shown as stars, on the
 *  input line and in the transcript. The school's PLEASE LOGON WITH USER
 *  PASSWORD: and the W.O.P.R.'s ACCESS CODE: (docs/api-contract.md §4.6) —
 *  never LOGON:, which asks for a name the film shows typed in the clear. */
export function isSecretPrompt(prompt: string): boolean {
  return /(?:PASSWORD|ACCESS CODE):?$/i.test(prompt.trim());
}

/** How long output may pause before a hold is given up on. A paced line
 *  delivers a quantum every few tens of milliseconds while a reply streams,
 *  and a turn's prompt follows its text directly, so this is far past both. */
const QUIET_MS = 1500;
/** How long a hold may wait for the first byte of a reply. Past the dialogue
 *  processor's own timeout (JOSHUA_TIMEOUT_S, 15s). */
const CEILING_MS = 30000;

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
  // Waiting on the far end: no input line, and Enter queues rather than sends.
  let held = false;
  const queued: string[] = [];
  const timers: Timers = opts.timers ?? {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  let quiet: unknown = null;
  let ceiling: unknown = null;
  const stopTimers = () => {
    if (quiet !== null) timers.clear(quiet);
    if (ceiling !== null) timers.clear(ceiling);
    quiet = ceiling = null;
  };
  const secret = () => mask || isSecretPrompt(prompt);

  const rowsFor = (s: string) => {
    const cols = term.cols > 0 ? term.cols : 80;
    return Math.max(1, Math.ceil(s.length / cols));
  };

  /** Erase the rows painted last time and write them again, optionally
   *  committing finished transcript lines into the scrollback on the way. */
  const paint = (committed: string[] = [], withInput = true) => {
    let out = "\r";
    if (above > 0) out += `\x1b[${above}A`;
    out += "\x1b[J"; // erase from here to the end of the screen
    for (const line of committed) out += `${line}\r\n`;
    let rows = 0;
    if (tail !== "") {
      out += tail;
      rows += rowsFor(tail);
    }
    if (enabled && !held && withInput) {
      if (tail !== "") out += "\r\n";
      const input = `${prompt} ${secret() ? "*".repeat(buf.length) : buf}`;
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
    if (held) {
      // Output is still arriving; the hold lasts until it goes quiet.
      if (quiet !== null) timers.clear(quiet);
      quiet = timers.set(release, QUIET_MS);
    }
  };

  // Exactly the rule the DOM renderer used: the newline is added only when the
  // transcript is mid-line, so a chunk that already starts a line does not
  // open a blank row above itself.
  const appendText = (s: string) => appendRaw(tail === "" ? s : `\n${s}`);

  /** Record the line in the transcript as it stood on the input line, then
   *  deliver it. The echo becomes the transcript's open last line, so the
   *  reply's leading newline ends it rather than opening a blank row. */
  const submit = (line: string) => {
    const echo = `${prompt} ${secret() ? "*".repeat(line.length) : line}`;
    const committed = tail !== "" ? [tail] : [];
    tail = echo;
    // No input line yet: the page may hold it for the reply, and drawing one
    // first would flash the question just answered under its own answer.
    paint(committed, false);
    opts.onLine(line, echo);
    if (!held) paint();
  };

  function release() {
    stopTimers();
    if (!held) return;
    held = false;
    paint();
    // Typed ahead during the reply: it answers the question just asked.
    const next = queued.shift();
    if (next !== undefined && enabled) submit(next);
  }

  const setPrompt = (p: string) => {
    prompt = p;
    if (held) release();
    else paint();
  };

  const data = term.onData((d: string) => {
    if (disposed || !enabled) return;
    for (const ch of d.replace(ESCAPE_SEQUENCE, "")) {
      if (ch === "\x03") {
        opts.onBreak?.();
      } else if (ch === "\r" || ch === "\n") {
        const line = buf;
        buf = "";
        if (held) queued.push(line);
        else submit(line);
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
      if (!on) {
        // A line that went down takes its unanswered turn with it.
        buf = "";
        held = false;
        queued.length = 0;
        stopTimers();
      }
      paint();
    },
    hold: () => {
      if (held || disposed) return;
      held = true;
      ceiling = timers.set(release, CEILING_MS);
      paint();
    },
    release,
    dispose: () => {
      disposed = true;
      stopTimers();
      data.dispose();
    },
  };
}
