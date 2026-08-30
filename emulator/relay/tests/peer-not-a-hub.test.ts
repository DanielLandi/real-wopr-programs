// A peer is not a hub (#87). A relay that holds a tie line OUT to a hub has no
// business holding a registry of other people's exchanges: nothing that
// reaches its `/trunk` may REGISTER, whatever the port is bound to. The
// refusal is a distinct terminal close, `4463 not a hub`, so a tie line
// pointed at a peer by mistake stops and says so rather than redialling a
// socket that will refuse it forever.
//
// Deliberately NOT in server.test.ts / peer-callback.test.ts: those files are
// being edited by other rounds.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "./loopback.ts";
import { startTieline } from "../src/tieline.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

function fastConfig() {
  const c = structuredClone(DEFAULT_CONFIG);
  c.mode = "fast";
  return c;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

function captureConsole(stream: "error" | "log"): { lines: string[]; restore: () => void } {
  const original = console[stream];
  const lines: string[] = [];
  console[stream] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console[stream] = original; } };
}

const REGISTER = JSON.stringify({
  t: "REGISTER", v: 1, name: "STRAY EXCH", region: "NOWHERE", joshua: "period", world: 2, slot: "PANAM",
});

/** A peer: a relay with a tie line configured out to a hub that is never up
 *  (port 9 is closed), so its own /trunk is the only thing under test. */
function startPeer(opts: { reconnect?: boolean } = {}) {
  return startServer({
    port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9",
    tieline: {
      hubUrl: "ws://127.0.0.1:9/trunk", name: "BASEMENT EXCH",
      region: "PORTLAND US", joshua: "period", reconnect: opts.reconnect ?? false,
    },
  });
}

test("a peer's /trunk refuses a REGISTER with 4463 not a hub", { timeout: 10_000 }, async () => {
  const peer = await startPeer();
  try {
    assert.ok(peer.tieline, "the relay under test must be a peer");
    const ws = await connect(`ws://127.0.0.1:${peer.port}/trunk`);
    const closed = nextClose(ws);
    // The socket is refused before it says anything; a REGISTER sent into
    // the closing socket must change nothing.
    try { ws.send(REGISTER); } catch { /* already closing */ }
    const { code, reason } = await closed;
    assert.equal(code, 4463);
    assert.equal(reason, "not a hub");

    // And nothing was placed on the board: the directory stays empty.
    const dir = await fetch(`http://127.0.0.1:${peer.port}/trunk/directory`).then((r) => r.json()) as
      { worlds: Array<{ slots: unknown[] }> };
    assert.deepEqual(dir.worlds.flatMap((w) => w.slots), []);
  } finally {
    await peer.close();
  }
});

test("a peer's /trunk refuses even a REGISTER that arrives with the open", { timeout: 10_000 }, async () => {
  // Belt and braces for the guard above: a REGISTER queued on the socket
  // before the refusal lands is never handed to the switchboard either.
  const peer = await startPeer();
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${peer.port}/trunk`);
    const closed = nextClose(ws);
    const first = new Promise<string>((resolve) => ws.once("message", (d) => resolve(d.toString())));
    ws.once("open", () => ws.send(REGISTER));
    const { code } = await closed;
    assert.equal(code, 4463);
    // No ASSIGNED ever came back — the only message a REGISTER could earn.
    const raced = await Promise.race([first, new Promise<string>((r) => setTimeout(() => r("nothing"), 200))]);
    assert.equal(raced, "nothing");
  } finally {
    await peer.close();
  }
});

test("a tie line dialled at a peer stops for good and says LINE REFUSED — NOT A HUB", { timeout: 10_000 }, async () => {
  const peer = await startPeer();
  const errors = captureConsole("error");
  let assignedCount = 0;
  const line = startTieline({
    hubUrl: `ws://127.0.0.1:${peer.port}/trunk`,
    localComms: "ws://127.0.0.1:9", localBridge: "http://127.0.0.1:9",
    name: "MISTAKEN EXCH", region: "NOWHERE", joshua: "period",
    world: 2, slot: "PANAM",
    // reconnect left ON: the point is that a terminal refusal stops the
    // redial loop by itself, not that the test turned it off.
    onAssigned: () => { assignedCount += 1; },
  });
  try {
    const deadline = Date.now() + 3000;
    while (!errors.lines.some((l) => l.includes("LINE REFUSED")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(errors.lines.some((l) => l === "LINE REFUSED — NOT A HUB"),
      `expected the terminal refusal; got ${JSON.stringify(errors.lines)}`);
    assert.equal(assignedCount, 0);
    assert.equal(line.assigned(), false);
    // No redial: a second refusal would print a second line.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(errors.lines.filter((l) => l.includes("LINE REFUSED")).length, 1);
  } finally {
    errors.restore();
    line.stop();
    await peer.close();
  }
});

test("a hub still accepts a REGISTER, even with a stray TRUNK_HUB_URL", { timeout: 10_000 }, async () => {
  // The inverse guard from #85: a seeded relay is a hub whatever its
  // environment says, so it keeps its switchboard and its /trunk.
  const errors = captureConsole("error");
  const hub = await startServer({
    port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9",
    trunk: {
      reservedWorlds: [],
      localWorld: [{ slot: "WOPR", name: "CHEYENNE MOUNTAIN", region: "SAO PAULO BR" }],
    },
    tieline: {
      hubUrl: "ws://127.0.0.1:9/trunk", name: "CHEYENNE MOUNTAIN",
      region: "SAO PAULO BR", joshua: "period", reconnect: false,
    },
  });
  try {
    assert.equal(hub.tieline, undefined);
    const ws = await connect(`ws://127.0.0.1:${hub.port}/trunk`);
    const reply = nextMessage(ws);
    ws.send(REGISTER);
    const assigned = JSON.parse(await reply) as { t: string; slot: string };
    assert.equal(assigned.t, "ASSIGNED");
    assert.equal(assigned.slot, "PANAM");
    ws.close();
  } finally {
    errors.restore();
    await hub.close();
  }
});

test("a plain relay with no trunk out still accepts a REGISTER", { timeout: 10_000 }, async () => {
  const relay = await startServer({
    port: 0, config: fastConfig(), bridgeUrl: "ws://127.0.0.1:9", trunk: { reservedWorlds: [] },
  });
  try {
    const ws = await connect(`ws://127.0.0.1:${relay.port}/trunk`);
    const reply = nextMessage(ws);
    ws.send(REGISTER);
    assert.equal((JSON.parse(await reply) as { t: string }).t, "ASSIGNED");
    ws.close();
  } finally {
    await relay.close();
  }
});
