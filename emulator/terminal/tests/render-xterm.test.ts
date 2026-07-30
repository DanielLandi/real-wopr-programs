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
import { mountXterm, type TerminalLike } from "../src/render-xterm.ts";

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
  assert.equal(row(t, 0), "> ", "the input line is cleared for the next command");
  void m;
});

test("the page's echo lands after the input line is cleared, not through it", async () => {
  // Both surfaces echo the submitted command into the transcript themselves.
  // If Enter delivered the line before clearing, that echo would paint into a
  // row still holding the typed text.
  const t = term();
  const seen: string[] = [];
  const m = mountXterm({
    term: t as TerminalLike,
    onLine: (l) => {
      seen.push(l);
      m.sinks.appendText(`> ${l}\n`);
    },
  });
  await flush(t);
  type(t, "HELP\r");
  await flush(t);
  assert.deepEqual(seen, ["HELP"]);
  assert.equal(row(t, 0), "> HELP");
  assert.equal(row(t, 1), "> ");
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
