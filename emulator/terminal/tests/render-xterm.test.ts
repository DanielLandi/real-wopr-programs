// The web renderer, driven the way the link drives it.
//
// A real xterm — @xterm/headless is the same emulator core the browser build
// uses, minus the canvas — so these read the actual screen the visitor would
// see, not a mock's call log. No DOM, no jsdom: bare `node --test`.
//
// The property this file exists to hold: output and the input line share one
// screen, and every arriving chunk repaints the input line without disturbing
// the transcript line it is streaming into. Chunks arrive two bytes at a time
// at dialup-300, so "erase the line, write the chunk" — the obvious
// implementation — would leave the last quantum alone on the row.

import { test } from "node:test";
import assert from "node:assert/strict";
// @xterm/headless ships CommonJS; take the class off the default export.
import xterm from "@xterm/headless";
const { Terminal } = xterm;
type Terminal = InstanceType<typeof Terminal>;
import { isSecretPrompt, mountXterm, type TerminalLike, type Timers } from "../src/render-xterm.ts";

function term(cols = 40, rows = 12): Terminal {
  return new Terminal({ cols, rows, allowProposedApi: true });
}

/** xterm parses asynchronously; park until the queue drains. */
function flush(t: Terminal): Promise<void> {
  return new Promise((r) => t.write("", () => r()));
}

/** One row of the live screen, as displayed (trailing blanks trimmed). */
function row(t: Terminal, y: number): string {
  return t.buffer.active.getLine(y)?.translateToString(true) ?? "";
}

/** The row the cursor rests on — always the last row of the input line. */
function cursorRow(t: Terminal): number {
  return t.buffer.active.cursorY;
}

/** Type at the terminal the way a person does; xterm routes it to onData. */
function type(t: Terminal, s: string): void {
  t.input(s);
}

/** Hand-cranked timers: a test decides when the fallback fires. */
function fakeTimers() {
  let next = 1;
  const armed = new Map<number, { fn: () => void; ms: number }>();
  const timers: Timers = {
    set: (fn, ms) => { const id = next++; armed.set(id, { fn, ms }); return id; },
    clear: (id) => { armed.delete(id as number); },
  };
  /** Fire every armed timer of this length. */
  const fire = (ms: number) => {
    for (const [id, a] of [...armed]) if (a.ms === ms) { armed.delete(id); a.fn(); }
  };
  return { timers, fire, armed };
}

test("streamed chunks continue one transcript line under the input line", async () => {
  const t = term();
  const m = mountXterm({ term: t as TerminalLike, onLine: () => {} });
  await flush(t);
  assert.equal(row(t, 0), "> ", "the input line is painted at mount");

  // dialup-300 emission quanta: 2 bytes at a time (docs/comms-protocol.md §3).
  m.sinks.appendRaw("WO");
  await flush(t);
  assert.equal(row(t, 0), "WO");
  assert.equal(row(t, 1), "> ");

  // The discriminating step: a renderer that erased the row before each chunk
  // would show "UL" here instead of "WOUL".
  m.sinks.appendRaw("UL");
  await flush(t);
  assert.equal(row(t, 0), "WOUL");
  assert.equal(row(t, 1), "> ");

  for (const q of ["D ", "YO", "U"]) m.sinks.appendRaw(q);
  m.sinks.appendRaw("\n");
  await flush(t);
  assert.equal(row(t, 0), "WOULD YOU");

  // A prompt arriving after the line is committed repaints whole on its own
  // row — the transcript above it is untouched.
  m.sinks.setPrompt("[TTT]>");
  await flush(t);
  assert.equal(row(t, 0), "WOULD YOU");
  assert.equal(row(t, 1), "[TTT]> ");
  assert.equal(cursorRow(t), 1);
});

test("typing echoes, Backspace edits, Enter delivers the line and clears it", async () => {
  const t = term();
  const lines: string[] = [];
  const m = mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l) });
  await flush(t);

  type(t, "HELO\x7f\x7fLP"); // \x7f is DEL — the key marked Backspace
  await flush(t);
  assert.equal(row(t, 0), "> HELP");

  type(t, "\r");
  await flush(t);
  assert.deepEqual(lines, ["HELP"]);
  assert.equal(row(t, 0), "> HELP", "the line as typed stays in the transcript");
  assert.equal(row(t, 1), "> ", "a fresh input line under it");
  void m;
});

test("Enter records the prompt the line answered, not a stock one", async () => {
  // The transcript is what was on the screen. A system that asked SELECT: must
  // leave "SELECT: LIST" behind, not "> LIST" with the question gone.
  const t = term();
  const seen: Array<[string, string]> = [];
  const m = mountXterm({ term: t as TerminalLike, onLine: (l, echo) => seen.push([l, echo]) });
  m.setPrompt("SELECT:");
  type(t, "LIST\r");
  await flush(t);
  assert.deepEqual(seen, [["LIST", "SELECT: LIST"]]);
  assert.equal(row(t, 0), "SELECT: LIST");

  // The far end's reply starts with a newline; it must not open a blank row
  // under the echo.
  m.sinks.appendRaw("\n0001 ADAMS\n");
  await flush(t);
  assert.equal(row(t, 0), "SELECT: LIST");
  assert.equal(row(t, 1), "0001 ADAMS");
  assert.equal(row(t, 2), "SELECT: ");

  // A page answering locally starts its text on a fresh line as well.
  type(t, "HELP\r");
  m.sinks.appendText("NO HELP HERE\n");
  await flush(t);
  assert.equal(row(t, 2), "SELECT: HELP");
  assert.equal(row(t, 3), "NO HELP HERE");
});

test("appendText opens a fresh line only when the transcript is mid-line", async () => {
  // The rule the DOM renderer used, preserved exactly: a chunk that must start
  // on its own line adds the newline itself, and only when one is needed.
  const t = term();
  const m = mountXterm({ term: t as TerminalLike, onLine: () => {} });

  m.sinks.appendText("READY.\n"); // nothing written yet — no leading blank row
  await flush(t);
  assert.equal(row(t, 0), "READY.");
  assert.equal(row(t, 1), "> ");

  m.sinks.appendText("DIALING...\n"); // transcript ends on a newline — no blank row
  await flush(t);
  assert.equal(row(t, 1), "DIALING...");

  m.sinks.appendRaw("LOGON: "); // now mid-line
  m.sinks.appendText("NO CARRIER\n");
  await flush(t);
  assert.equal(row(t, 2), "LOGON: ");
  assert.equal(row(t, 3), "NO CARRIER");
  assert.equal(row(t, 4), "> ");
});

test("a transcript line that wraps keeps the input line under it", async () => {
  // The repaint walks back over the rows it painted last time. If it counted
  // rows instead of measuring them, a wrapped transcript line would leave a
  // stale copy of the input line stranded in the middle of the screen.
  const t = term(20);
  const m = mountXterm({ term: t as TerminalLike, onLine: () => {} });
  m.sinks.appendRaw("SHALL WE PLAY A G"); // 17 of 20 columns
  await flush(t);
  assert.equal(row(t, 0), "SHALL WE PLAY A G");
  assert.equal(row(t, 1), "> ");

  m.sinks.appendRaw("AME?"); // now 21 columns — wraps onto a second row
  await flush(t);
  assert.equal(row(t, 0), "SHALL WE PLAY A GAME");
  assert.equal(row(t, 1), "?");
  assert.equal(row(t, 2), "> ");
  assert.equal(cursorRow(t), 2);

  // And the paint after it must walk back over all three rows. Counting them
  // instead of measuring them starts the repaint one row too low, which
  // duplicates the wrapped transcript line and pushes the input line down.
  m.setPrompt("[TTT]>");
  await flush(t);
  assert.equal(row(t, 0), "SHALL WE PLAY A GAME");
  assert.equal(row(t, 1), "?");
  assert.equal(row(t, 2), "[TTT]> ");
  assert.equal(row(t, 3), "");
});

test("an input line that wraps repaints without stranding a copy", async () => {
  const t = term(20);
  const lines: string[] = [];
  mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l) });
  type(t, "LIST GAMES PLEASE NOW"); // "> " + 21 chars = 23 columns
  await flush(t);
  assert.equal(row(t, 0), "> LIST GAMES PLEASE ");
  assert.equal(row(t, 1), "NOW");
  type(t, "\x7f\x7f\x7f\x7f"); // erase " NOW" — back under one row's worth
  await flush(t);
  assert.equal(row(t, 0), "> LIST GAMES PLEASE");
  assert.equal(row(t, 1), "", "the wrapped remainder is erased, not left behind");
});

test("masked input echoes nothing readable but delivers the line intact", async () => {
  // NORAD access codes (norad-terminal's logon flow).
  const t = term();
  const lines: string[] = [];
  const m = mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l) });
  m.setMask(true);
  type(t, "CPE1704TKS");
  await flush(t);
  assert.equal(row(t, 0), "> **********");
  type(t, "\r");
  await flush(t);
  assert.deepEqual(lines, ["CPE1704TKS"]);
  assert.equal(row(t, 0), "> **********", "and the transcript keeps only the stars");
});

test("a password prompt masks by itself, in the input line and the transcript", async () => {
  // The school's logon (systems/school-mon): nobody calls setMask — the
  // prompt alone says the line is secret.
  const t = term(60);
  const seen: Array<[string, string]> = [];
  const m = mountXterm({
    term: t as TerminalLike, uppercase: true, onLine: (l, echo) => seen.push([l, echo]),
  });
  m.setPrompt("PLEASE LOGON WITH USER PASSWORD:");
  type(t, "pencil");
  await flush(t);
  assert.equal(row(t, 0), "PLEASE LOGON WITH USER PASSWORD: ******");
  type(t, "\r");
  await flush(t);
  assert.deepEqual(seen, [["PENCIL", "PLEASE LOGON WITH USER PASSWORD: ******"]]);
  assert.equal(row(t, 0), "PLEASE LOGON WITH USER PASSWORD: ******");

  // The next question is not secret, and the mask goes with the prompt.
  m.setPrompt("SELECT:");
  type(t, "list");
  await flush(t);
  assert.equal(row(t, 1), "SELECT: LIST");
});

test("isSecretPrompt: passwords and access codes, never a user name", () => {
  assert.equal(isSecretPrompt("PLEASE LOGON WITH USER PASSWORD:"), true);
  assert.equal(isSecretPrompt("PASSWORD"), true);
  assert.equal(isSecretPrompt("ACCESS CODE:"), true);
  assert.equal(isSecretPrompt("LOGON:"), false, "the film shows JOSHUA typed in the clear");
  assert.equal(isSecretPrompt("SELECT:"), false);
  assert.equal(isSecretPrompt(">"), false);
});

test("while the far end is answering there is no input line, only the cursor after the text", async () => {
  // At 300 baud a reply takes seconds. The old screen kept the previous
  // question on an input line under it the whole time and swapped it only when
  // the last byte landed; a terminal shows the cursor where the text stopped.
  const t = term();
  const { timers } = fakeTimers();
  const m = mountXterm({
    term: t as TerminalLike, timers, uppercase: true, onLine: () => m.hold(),
  });
  m.setPrompt("SELECT:");
  const writes: string[] = [];
  const spy = t.write.bind(t);
  (t as { write: (d: string, cb?: () => void) => void }).write = (d, cb) => {
    writes.push(d);
    spy(d, cb);
  };
  type(t, "list\r");
  await flush(t);
  assert.equal(row(t, 0), "SELECT: LIST");
  assert.equal(row(t, 1), "", "no input line while held");
  assert.ok(
    !writes.some((w) => w.includes("\r\nSELECT: ") || w.endsWith("SELECT: ")),
    "and none was drawn in between: the answered question never flashes back",
  );
  assert.equal(cursorRow(t), 0);

  m.sinks.appendRaw("\n0001 AD");
  await flush(t);
  assert.equal(row(t, 1), "0001 AD");
  assert.equal(row(t, 2), "");
  assert.equal(cursorRow(t), 1, "the cursor rides the end of the streaming text");

  // Typing ahead is kept but not shown until the machine asks again.
  type(t, "m");
  m.sinks.appendRaw("AMS\n");
  await flush(t);
  assert.equal(row(t, 2), "");

  m.sinks.setPrompt("MORE - TYPE M");
  await flush(t);
  assert.equal(row(t, 1), "0001 ADAMS");
  assert.equal(row(t, 2), "MORE - TYPE M M");
});

test("a line entered while held waits for the next prompt, then answers it", async () => {
  const t = term();
  const { timers } = fakeTimers();
  const seen: Array<[string, string]> = [];
  const m = mountXterm({
    term: t as TerminalLike, timers,
    onLine: (l, echo) => { seen.push([l, echo]); m.hold(); },
  });
  type(t, "A\r");
  type(t, "B\r");
  await flush(t);
  assert.deepEqual(seen, [["A", "> A"]], "B is typed ahead, not sent into a reply");

  m.sinks.appendRaw("\nOK\n");
  m.setPrompt("NEXT:");
  await flush(t);
  assert.deepEqual(seen, [["A", "> A"], ["B", "NEXT: B"]]);
  assert.equal(row(t, 1), "OK");
  assert.equal(row(t, 2), "NEXT: B");
});

test("a reply that never sends a prompt still gives the line back", async () => {
  // Not every turn ends with a prompt frame: *** BREAK ***, OBSERVE GTW, and
  // a SYSTEM/1 program's PROMPT is optional. Output going quiet ends the hold,
  // and so does a reply that never comes at all.
  const t = term();
  const { timers, fire, armed } = fakeTimers();
  const m = mountXterm({ term: t as TerminalLike, timers, onLine: () => m.hold() });
  type(t, "BREAK\r");
  m.sinks.appendRaw("\n*** BREAK ***\n");
  await flush(t);
  assert.equal(row(t, 2), "");
  fire(1500);
  await flush(t);
  assert.equal(row(t, 2), "> ", "the resting prompt comes back once the line goes quiet");
  assert.equal(armed.size, 0, "and the ceiling timer is cancelled with it");

  type(t, "HELLO\r");
  await flush(t);
  fire(30000);
  await flush(t);
  assert.equal(row(t, 2), "> HELLO");
  assert.equal(row(t, 3), "> ", "no reply at all: the ceiling releases it");
});

test("caps-only terminals uppercase what is typed and what is delivered", async () => {
  const t = term();
  const lines: string[] = [];
  mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l), uppercase: true });
  type(t, "help\r");
  await flush(t);
  assert.deepEqual(lines, ["HELP"]);
});

test("Ctrl+C raises BREAK and never enters the buffer", async () => {
  const t = term();
  const lines: string[] = [];
  let breaks = 0;
  mountXterm({
    term: t as TerminalLike,
    onLine: (l) => lines.push(l),
    onBreak: () => { breaks += 1; },
  });
  type(t, "AB\x03CD\r");
  await flush(t);
  assert.equal(breaks, 1);
  assert.deepEqual(lines, ["ABCD"]);
});

test("arrow keys and other escape sequences are not typed into the line", async () => {
  // A 1983 line editor has no history and no cursor motion; the escape bytes
  // a modern keyboard sends must not land as literal "[A" in the command.
  const t = term();
  const lines: string[] = [];
  mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l) });
  type(t, "GA\x1b[AME\x1bOB\r");
  await flush(t);
  assert.deepEqual(lines, ["GAME"]);
});

test("a disabled input line is not painted and swallows keystrokes", async () => {
  // The NORAD console shows no command line until the leased line is up.
  const t = term();
  const lines: string[] = [];
  const m = mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l), prompt: "WOPR>" });
  m.setEnabled(false);
  m.sinks.appendRaw("SYNCHRONIZING\n");
  await flush(t);
  assert.equal(row(t, 0), "SYNCHRONIZING");
  assert.equal(row(t, 1), "", "no input line while the console is not connected");
  type(t, "HELP\r");
  await flush(t);
  assert.deepEqual(lines, []);

  m.setEnabled(true);
  await flush(t);
  assert.equal(row(t, 1), "WOPR> ");
});

test("dispose stops the line editor", async () => {
  const t = term();
  const lines: string[] = [];
  const m = mountXterm({ term: t as TerminalLike, onLine: (l) => lines.push(l) });
  m.dispose();
  type(t, "HELP\r");
  await flush(t);
  assert.deepEqual(lines, []);
});
