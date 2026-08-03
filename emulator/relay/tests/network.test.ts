// One relay per network, end to end over real sockets: a node registers its
// lines, a caller dials one, and opaque frames cross between them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startNetworkRelay, profileFor, type NetworkDescriptor } from "../src/network.ts";
import { decodeNodeFrame, encodeNodeFrame, type NodeFrame } from "../src/node-proto.ts";
import { decodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

const PSTN: NetworkDescriptor = {
  name: "pstn", kind: "dialup", addressing: "phone", baud: 300, public: true, private: false,
};
const BUS: NetworkDescriptor = {
  name: "bus", kind: "local", addressing: "name", public: false, private: true,
};

/** Connect and collect NODE/1 frames, with a promise per awaited type. */
function nodeClient(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/node`);
  const seen: NodeFrame[] = [];
  const waiters: Array<{ t: string; resolve: (f: NodeFrame) => void }> = [];
  ws.on("message", (d) => {
    const f = decodeNodeFrame(d.toString());
    seen.push(f);
    const i = waiters.findIndex((w) => w.t === f.t);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(f);
  });
  return {
    ws, seen,
    open: () => new Promise<void>((r) => ws.once("open", () => r())),
    send: (f: NodeFrame) => ws.send(encodeNodeFrame(f)),
    next: (t: string) => new Promise<NodeFrame>((resolve) => {
      const hit = seen.find((f) => f.t === t);
      if (hit) return resolve(hit);
      waiters.push({ t, resolve });
    }),
  };
}

function dialClient(port: number, address: string, from = "console") {
  const url = `ws://127.0.0.1:${port}/dial?address=${encodeURIComponent(address)}&from=${from}`;
  const ws = new WebSocket(url);
  const text: string[] = [];
  const envelopes: Envelope[] = [];
  ws.on("message", (d) => {
    const e = decodeEnvelope(d.toString());
    envelopes.push(e);
    if (e.payload) text.push(e.payload);
  });
  return {
    ws, text, envelopes,
    open: () => new Promise<void>((r) => ws.once("open", () => r())),
    closed: () => new Promise<{ code: number; reason: string }>((r) =>
      ws.once("close", (code, reason) => r({ code, reason: reason.toString() }))),
    waitFor: async (needle: string, ms = 3000) => {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (text.join("").includes(needle)) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    },
  };
}

test("network relay: a node registers and its claim is acknowledged", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0 });
  const node = nodeClient(relay.port);
  await node.open();
  node.send({ t: "REGISTER", v: 1, node: "school",
    claims: [{ network: "pstn", address: "(206) 555-0142", protocol: "SYSTEM/1" }] });
  const ack = await node.next("REGISTERED");
  assert.equal((ack as { node: string }).node, "school");
  node.ws.close();
  await relay.close();
});

test("network relay: a second node claiming the same line is REJECTED", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0 });
  const a = nodeClient(relay.port);
  await a.open();
  a.send({ t: "REGISTER", v: 1, node: "school",
    claims: [{ network: "pstn", address: "(206) 555-0142", protocol: "SYSTEM/1" }] });
  await a.next("REGISTERED");

  const b = nodeClient(relay.port);
  await b.open();
  b.send({ t: "REGISTER", v: 1, node: "impostor",
    claims: [{ network: "pstn", address: "206-555-0142", protocol: "SYSTEM/1" }] });
  const rej = await b.next("REJECTED");
  assert.match((rej as { reason: string }).reason, /already/);

  a.ws.close(); b.ws.close();
  await relay.close();
});

test("network relay: dialing a claimed line rings the node, and frames cross", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0, mode: "fast" });
  const node = nodeClient(relay.port);
  await node.open();
  node.send({ t: "REGISTER", v: 1, node: "school",
    claims: [{ network: "pstn", address: "(206) 555-0142", protocol: "SYSTEM/1" }] });
  await node.next("REGISTERED");

  const caller = dialClient(relay.port, "206-555-0142");
  await caller.open();

  const ring = await node.next("RING") as { call: number; address: string };
  assert.equal(ring.address, "2065550142");
  node.send({ t: "ANSWER", call: ring.call });
  node.send({ t: "FRAME", call: ring.call, data: "WELCOME TO THE SEATTLE PUBLIC SCHOOL DISTRICT DATANET" });

  assert.equal(await caller.waitFor("SEATTLE PUBLIC SCHOOL"), true);

  caller.ws.close(); node.ws.close();
  await relay.close();
});

test("network relay: a node's PROMPT frame reaches the caller as a prompt envelope", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0, mode: "fast" });
  const node = nodeClient(relay.port);
  await node.open();
  node.send({ t: "REGISTER", v: 1, node: "school",
    claims: [{ network: "pstn", address: "(206) 555-0142", protocol: "SYSTEM/1" }] });
  await node.next("REGISTERED");

  const caller = dialClient(relay.port, "206-555-0142");
  await caller.open();

  const ring = await node.next("RING") as { call: number; address: string };
  node.send({ t: "ANSWER", call: ring.call });
  node.send({ t: "PROMPT", call: ring.call, data: "TEST:" });

  const until = Date.now() + 3000;
  while (Date.now() < until && !caller.envelopes.some((e) => e.kind === "prompt")) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const promptFrames = caller.envelopes.filter((e) => e.kind === "prompt");
  assert.ok(promptFrames.length > 0, "expected at least one prompt envelope");
  assert.deepEqual(reassemble(promptFrames), ["TEST:"]);

  caller.ws.close(); node.ws.close();
  await relay.close();
});

test("network relay: dialing an unclaimed line gets no answer", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0, mode: "fast" });
  const caller = dialClient(relay.port, "(555) 555-5555");
  const { reason } = await caller.closed();
  assert.match(reason, /NO ANSWER/);
  await relay.close();
});

test("network relay: when the node drops, an in-flight caller is closed", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0, mode: "fast" });
  const node = nodeClient(relay.port);
  await node.open();
  node.send({ t: "REGISTER", v: 1, node: "school",
    claims: [{ network: "pstn", address: "(206) 555-0142", protocol: "SYSTEM/1" }] });
  await node.next("REGISTERED");

  const caller = dialClient(relay.port, "(206) 555-0142");
  await caller.open();
  const ring = await node.next("RING") as { call: number };
  node.send({ t: "ANSWER", call: ring.call });

  node.ws.close();
  const { reason } = await caller.closed();
  assert.match(reason, /CARRIER/);
  await relay.close();
});

test("network relay: a private network binds loopback only", async () => {
  const relay = await startNetworkRelay(BUS, { port: 0 });
  assert.equal(relay.address, "127.0.0.1");
  await relay.close();
});

test("network relay: a public network binds all interfaces", async () => {
  const relay = await startNetworkRelay(PSTN, { port: 0 });
  assert.equal(relay.address, "0.0.0.0");
  await relay.close();
});

test("network relay: callable_by keeps a store unreachable by the wrong caller", async () => {
  const relay = await startNetworkRelay(BUS, { port: 0, mode: "fast" });
  const store = nodeClient(relay.port);
  await store.open();
  store.send({ t: "REGISTER", v: 1, node: "school-db",
    claims: [{ network: "bus", address: "SCHOOL-DB", protocol: "SYSTEM/1" }] });
  await store.next("REGISTERED");
  relay.setCallableBy("school-db", ["school"]);

  const wrong = dialClient(relay.port, "SCHOOL-DB", "airline");
  const { reason } = await wrong.closed();
  assert.match(reason, /NO ANSWER/);

  store.ws.close();
  await relay.close();
});

test("profileFor honors a declared baud that matches a tuned profile", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone", baud: 1200 }, "authentic");
  assert.equal(p.baud, 1200);
  assert.equal(p.handshake, "dialup");
});

test("profileFor without a declared baud keeps the kind default", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone" }, "authentic");
  assert.equal(p.baud, 300);
});

test("profileFor with an unmatched baud falls back to the kind default", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone", baud: 600 }, "authentic");
  assert.equal(p.baud, 300);
});
