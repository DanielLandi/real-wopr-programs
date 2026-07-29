// The console renderer: reprinting the prompt on every arrival.
//
// protocol.ts already proves a prompt reassembles and updates `line.prompt()`
// without leaking into the text stream; this file proves the TTY renderer
// repaints the input line each time one arrives, not only the first — a
// system re-sends the same question after every turn.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { WebSocketServer } from "ws";
import { runTerminal } from "../src/render-tty.ts";

/** A stand-in for the relay's caller leg. */
async function fakeRelay(handler: (ws: any, url: URL) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  wss.on("connection", (ws, req) =>
    handler(ws, new URL(req.url ?? "/", "http://relay.invalid")));
  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

function promptEnvelope(payload: string, seq: number) {
  return JSON.stringify({
    v: 1, session: "s", seq, kind: "prompt", link: "pstn", payload, eom: true,
  });
}

/** A writable stream that only accumulates what was written to it. */
function captureOutput() {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk.toString()); cb(); },
  });
  return { output, text: () => chunks.join("") };
}

test("render-tty: an identical prompt repaints on every arrival, not only the first", async () => {
  const relay = await fakeRelay((ws) => {
    ws.send(promptEnvelope("TEST:", 0));
    ws.send(promptEnvelope("TEST:", 1));
    setTimeout(() => ws.close(1000, "NO CARRIER"), 100);
  });

  const { output, text } = captureOutput();
  const input = new Readable({ read() {} });

  await runTerminal(relay.url, "(206) 555-0142", { input, output });

  const out = text();
  const occurrences = out.split("TEST: ").length - 1;
  assert.equal(occurrences, 2, out);

  await relay.close();
});
