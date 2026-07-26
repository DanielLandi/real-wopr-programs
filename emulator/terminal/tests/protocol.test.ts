// The protocol half of the terminal: dialling, receiving, and staying free of
// anything terminal-shaped.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { dial, dialUrl } from "../src/protocol.ts";

function envelope(payload: string, eom = true) {
  return JSON.stringify({
    v: 1, session: "t", seq: 1, kind: "output", link: "pstn", payload, eom,
  });
}

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

test("protocol.ts imports nothing terminal-shaped", () => {
  // Sub-project #4 renders this same module through xterm.js. If the protocol
  // half ever reaches for stdout, that stops being possible.
  //
  // Comments are stripped first: the file's own header explains that it avoids
  // these things, and prose describing a rule should not trip the rule.
  const src = readFileSync(new URL("../src/protocol.ts", import.meta.url), "utf8");
  const code = src
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /node:tty|process\.stdout|process\.stdin|node:readline/);
});

test("dialUrl carries the address and the caller", () => {
  const url = dialUrl("ws://h:1", "(206) 555-0142", "console");
  assert.match(url, /address=%28206%29\+555-0142/);
  assert.match(url, /from=console/);
});

test("dial: text from the far end arrives in order", async () => {
  const relay = await fakeRelay((ws) => {
    ws.send(envelope("GOOSE LAKE UNIFIED SCHOOL DISTRICT"));
    ws.send(envelope("PASSWORD:"));
  });
  const line = await dial(relay.url, "(206) 555-0142");
  const got: string[] = [];
  for await (const chunk of line.output) {
    got.push(chunk);
    if (got.length === 2) break;
  }
  assert.deepEqual(got, ["GOOSE LAKE UNIFIED SCHOOL DISTRICT", "PASSWORD:"]);
  line.hangUp();
  await relay.close();
});

test("dial: what the caller types reaches the far end verbatim", async () => {
  let seen = "";
  const relay = await fakeRelay((ws) => {
    ws.on("message", (d: Buffer) => { seen = d.toString(); });
  });
  const line = await dial(relay.url, "(206) 555-0142");
  line.send("PENCIL");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(seen, "PENCIL");
  line.hangUp();
  await relay.close();
});

test("dial: a line nobody holds closes with NO ANSWER", async () => {
  const relay = await fakeRelay((ws) => ws.close(1000, "NO ANSWER"));
  const line = await dial(relay.url, "(555) 555-5555");
  assert.equal(await line.closed, "NO ANSWER");
  await relay.close();
});

test("dial: the caller is told which caller it claimed to be", async () => {
  let from = "";
  const relay = await fakeRelay((ws, url) => {
    from = url.searchParams.get("from") ?? "";
    ws.close(1000, "NO ANSWER");
  });
  const line = await dial(relay.url, "SCHOOL-DB", { from: "airline" });
  await line.closed;
  assert.equal(from, "airline");
  await relay.close();
});

test("dial: an unreachable relay ends the call rather than throwing", async () => {
  const line = await dial("ws://127.0.0.1:1", "(206) 555-0142");
  assert.equal(await line.closed, "NO CARRIER");
});

test("dial: a frame that is not valid JSON does not drop the call", async () => {
  const relay = await fakeRelay((ws) => {
    ws.send("{ this is not json");
    ws.send(envelope("STILL HERE"));
  });
  const line = await dial(relay.url, "(206) 555-0142");
  for await (const chunk of line.output) {
    assert.equal(chunk, "STILL HERE");
    break;
  }
  line.hangUp();
  await relay.close();
});

test("dial: output ends when the far end hangs up", async () => {
  const relay = await fakeRelay((ws) => {
    ws.send(envelope("BYE"));
    setTimeout(() => ws.close(1000, "NO CARRIER"), 50);
  });
  const line = await dial(relay.url, "(206) 555-0142");
  const got: string[] = [];
  for await (const chunk of line.output) got.push(chunk);
  assert.deepEqual(got, ["BYE"]);
  assert.equal(await line.closed, "NO CARRIER");
  await relay.close();
});

test("dial: a prompt frame updates the prompt without printing as text", async () => {
  const relay = await fakeRelay((ws) => {
    ws.send(envelope("TIC-TAC-TOE"));
    ws.send(JSON.stringify({
      v: 1, session: "t", seq: 2, kind: "prompt",
      link: "pstn", payload: "[TTT]>", eom: true,
    }));
    ws.send(envelope("YOUR MOVE"));
  });
  const line = await dial(relay.url, "(206) 555-0142");
  const got: string[] = [];
  for await (const chunk of line.output) {
    got.push(chunk);
    if (got.length === 2) break;
  }
  // The prompt is not teletype text — it must not appear in the stream.
  assert.deepEqual(got, ["TIC-TAC-TOE", "YOUR MOVE"]);
  assert.equal(line.prompt(), "[TTT]>");
  line.hangUp();
  await relay.close();
});

/** The frames a dialup-300 link really delivers for one message.
 *
 * The relay emits ~1/15 s of line rate per envelope, so at 300 baud / 10 bits
 * per char the quantum is floor(300/10/15) = 2 bytes, and only the last frame
 * carries eom (comms-protocol.md §5). The relay's own suite pins that the real
 * shaper still splits a prompt this way; this is the consumer half.
 */
function shapeAt300(kind: string, payload: string): string[] {
  const quantum = Math.floor(300 / 10 / 15);
  const frames: string[] = [];
  for (let i = 0; i < payload.length; i += quantum) {
    const slice = payload.slice(i, i + quantum);
    frames.push(JSON.stringify({
      v: 1, session: "t", seq: frames.length, kind,
      link: "dialup-300", payload: slice, eom: i + quantum >= payload.length,
    }));
  }
  return frames;
}

test("dial: a prompt chunked by a 300-baud line arrives whole", async () => {
  // The home terminal's own profile. A handler that replaced on every frame
  // instead of reassembling would show the last quantum alone — "]>".
  const relay = await fakeRelay((ws) => {
    for (const f of shapeAt300("prompt", "[TTT]>")) ws.send(f);
    ws.send(envelope("YOUR MOVE"));
  });
  const seen: string[] = [];
  const line = await dial(relay.url, "(206) 555-0142", {
    onPrompt: (p) => seen.push(p),
  });
  for await (const chunk of line.output) {
    assert.equal(chunk, "YOUR MOVE");
    break;
  }
  assert.equal(line.prompt(), "[TTT]>");
  // One reassembled message, not one callback per quantum.
  assert.deepEqual(seen, ["[TTT]>"]);
  line.hangUp();
  await relay.close();
});

test("dial: the prompt starts bare", async () => {
  const relay = await fakeRelay(() => {});
  const line = await dial(relay.url, "(206) 555-0142");
  assert.equal(line.prompt(), ">");
  line.hangUp();
  await relay.close();
});
