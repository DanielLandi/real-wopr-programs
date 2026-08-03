// TRUNK/1 codec, REST allowlist, and Switchboard registry tests (trunk-federation
// spec, Task 1). The hub relays call channels and an allowlisted REST subset
// down each trunk without ever inspecting payloads — these tests exercise the
// pure protocol layer only, no server wiring.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Switchboard,
  type DirectoryEntry,
  decodeTrunkFrame,
  restAllowed,
  newExchangeCode,
  TRUNK_ALPHABET,
  TRUNK_MAX_FRAME_BYTES,
  type TrunkFrame,
} from "../src/trunk.ts";

function fakePort() {
  const sent: string[] = [];
  let closed = false;
  let closeCode: number | undefined;
  let closeReason: string | undefined;
  return {
    sent,
    get closed() { return closed; },
    get closeCode() { return closeCode; },
    get closeReason() { return closeReason; },
    send: (d: string) => sent.push(d),
    close: (code?: number, reason?: string) => { closed = true; closeCode = code; closeReason = reason; },
  };
}

// `register` returns a world/slot placement (or a refusal string) and the
// directory is grouped by world — see tests/worlds.test.ts for those rules.
// The tests below predate worlds and care only about the exchange code and
// the flat roster of live exchanges; these two adapters keep them at that
// altitude instead of restating placement in every case.
const codeOf = (r: ReturnType<Switchboard["register"]>): string => {
  assert.equal(typeof r, "object", `expected a placement, got ${String(r)}`);
  return (r as { code: string }).code;
};
const flatDir = (sb: Switchboard, base: string): DirectoryEntry[] =>
  sb.directory(base).flatMap((w) => w.slots);

// ---- codec round-trip ----------------------------------------------------

test("codec: round-trips every frame type through JSON", () => {
  const frames: TrunkFrame[] = [
    { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" },
    { t: "REGISTER", v: 1, name: "CRYSTAL PALACE", region: "SEATTLE US", joshua: "claude", operator: "DANIEL" },
    { t: "REGISTER", v: 1, name: "SEATTLE SCHOOL", region: "SEATTLE US", joshua: "period", slot: "SCHOOL", world: 2 },
    { t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" },
    { t: "OPEN", chan: 1, query: "" },
    { t: "FRAME", chan: 1, data: "HELLO" },
    { t: "CLOSE", chan: 1 },
    { t: "CLOSE", chan: 1, reason: "call ended" },
    { t: "REQUEST", rid: 1, method: "GET", path: "/health" },
    { t: "REQUEST", rid: 1, method: "POST", path: "/api/session", body: "{}" },
    { t: "RESPONSE", rid: 1, status: 200, body: "{}" },
    { t: "PING" },
    { t: "PONG" },
  ];
  for (const f of frames) {
    const decoded = decodeTrunkFrame(JSON.stringify(f));
    assert.deepEqual(decoded, f);
  }
});

test("codec: throws on non-JSON input", () => {
  assert.throws(() => decodeTrunkFrame("not json"), Error);
});

test("codec: throws on unknown frame type", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "BOGUS" })), Error);
});

test("codec: throws on oversize frame (> 8192 bytes)", () => {
  const big = JSON.stringify({ t: "FRAME", chan: 1, data: "X".repeat(TRUNK_MAX_FRAME_BYTES) });
  assert.ok(Buffer.byteLength(big) > TRUNK_MAX_FRAME_BYTES);
  assert.throws(() => decodeTrunkFrame(big), Error);
});

test("codec: throws on REGISTER with name over 24 chars", () => {
  const raw = JSON.stringify({ t: "REGISTER", v: 1, name: "X".repeat(25), region: "PORTLAND US", joshua: "period" });
  assert.throws(() => decodeTrunkFrame(raw), Error);
});

test("codec: throws on REGISTER with bad joshua value", () => {
  const raw = JSON.stringify({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "gpt" });
  assert.throws(() => decodeTrunkFrame(raw), Error);
});

test("codec: throws on REGISTER with non-string operator", () => {
  const raw = JSON.stringify({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period", operator: 7 });
  assert.throws(() => decodeTrunkFrame(raw), Error);
});

test("codec: throws on REGISTER with operator over 24 chars", () => {
  const raw = JSON.stringify({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period", operator: "X".repeat(25) });
  assert.throws(() => decodeTrunkFrame(raw), Error);
});

test("codec: throws on FRAME with object data (wire type check, payload stays opaque)", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "FRAME", chan: 1, data: { x: 1 } })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "FRAME", chan: "1", data: "ok" })), Error);
});

test("codec: throws on RESPONSE with string status", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1, status: "200", body: "{}" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1, status: 200, body: null })), Error);
});

test("codec: throws on REQUEST with missing method", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "REQUEST", rid: 1, path: "/health" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "REQUEST", rid: 1, method: "POST", path: "/api/session", body: 5 })), Error);
});

test("codec: throws on OPEN/CLOSE/ASSIGNED with wrong field types", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "OPEN", chan: 1, query: 9 })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "CLOSE", chan: 1, reason: 42 })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "ASSIGNED", exchange: 123456 })), Error);
});

test("codec: throws on non-integer chan/rid/status (typeof number is not enough)", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "OPEN", chan: 1.5, query: "" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "FRAME", chan: 1.5, data: "X" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "CLOSE", chan: 1.5 })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "REQUEST", rid: 1.5, method: "GET", path: "/health" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1.5, status: 200, body: "{}" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1, status: 200.5, body: "{}" })), Error);
});

test("codec: throws on RESPONSE status outside the HTTP range (writeHead would throw)", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1, status: 99, body: "{}" })), Error);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "RESPONSE", rid: 1, status: 600, body: "{}" })), Error);
});

test("codec: throws on CLOSE reason too long to relay as a ws close reason", () => {
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "CLOSE", chan: 1, reason: "X".repeat(101) })), Error);
});

// ---- worlds and roster slots ----------------------------------------------

test("REGISTER accepts a roster slot and a world number or NEW", () => {
  const base = { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" };
  assert.equal(decodeTrunkFrame(JSON.stringify({ ...base, slot: "SCHOOL" })).t, "REGISTER");
  assert.equal(decodeTrunkFrame(JSON.stringify({ ...base, slot: "OTHER-2", world: 3 })).t, "REGISTER");
  assert.equal(decodeTrunkFrame(JSON.stringify({ ...base, world: "NEW" })).t, "REGISTER");
});

test("REGISTER rejects an off-roster slot and a bad world", () => {
  const base = { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" };
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, slot: "JOSHUA" })), /bad slot/);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, slot: "wopr" })), /bad slot/);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, world: 0 })), /bad world/);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, world: "FRESH" })), /bad world/);
});

test("REGISTER carries an optional reserve key, bounded at 64 chars", () => {
  const base = { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" };
  assert.equal(decodeTrunkFrame(JSON.stringify({ ...base, key: "K" })).t, "REGISTER");
  assert.equal(decodeTrunkFrame(JSON.stringify({ ...base, key: "X".repeat(64) })).t, "REGISTER");
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, key: "X".repeat(65) })), /bad key/);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ ...base, key: 7 })), /bad key/);
});

test("ASSIGNED requires world and slot", () => {
  assert.equal(decodeTrunkFrame(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1, slot: "WOPR" })).t, "ASSIGNED");
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234" })), /bad world/);
  assert.throws(() => decodeTrunkFrame(JSON.stringify({ t: "ASSIGNED", exchange: "ABC234", world: 1 })), /bad slot/);
});

// ---- REST allowlist -------------------------------------------------------

test("restAllowed: accepts the six allowlisted shapes", () => {
  assert.equal(restAllowed("POST", "/api/session"), true);
  assert.equal(restAllowed("GET", "/api/session/550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(restAllowed("POST", "/api/room"), true);
  assert.equal(restAllowed("GET", "/api/room/ABC234"), true);
  assert.equal(restAllowed("GET", "/api/games"), true);
  assert.equal(restAllowed("GET", "/health"), true);
});

test("restAllowed: is case-insensitive on method", () => {
  assert.equal(restAllowed("get", "/health"), true);
  assert.equal(restAllowed("post", "/api/session"), true);
});

test("restAllowed: rejects path traversal", () => {
  assert.equal(restAllowed("GET", "/api/session/../secret"), false);
});

test("restAllowed: rejects disallowed sub-resource path", () => {
  assert.equal(restAllowed("POST", "/api/session/x/defcon"), false);
});

test("restAllowed: rejects non-REST ws upgrade path", () => {
  assert.equal(restAllowed("GET", "/ws/session/abc"), false);
});

// ---- newExchangeCode -------------------------------------------------------

test("newExchangeCode: returns 6 chars from the alphabet", () => {
  for (let i = 0; i < 50; i++) {
    const code = newExchangeCode();
    assert.equal(code.length, 6);
    for (const ch of code) assert.ok(TRUNK_ALPHABET.includes(ch), `${ch} not in alphabet`);
  }
});

// ---- Switchboard: register/assign ------------------------------------------

test("Switchboard: register assigns a 6-char code and directory lists it", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  assert.equal(code.length, 6);
  const dir = flatDir(sb, "https://hub.example");
  assert.equal(dir.length, 1);
  assert.equal(dir[0].api, `https://hub.example/x/${code}`);
  assert.equal(dir[0].link, `wss://hub.example/x/${code}/link`);
});

test("Switchboard: second REGISTER on a full board returns 'full'", () => {
  const sb = new Switchboard({ maxExchanges: 1 });
  const host1 = fakePort();
  const host2 = fakePort();
  const code1 = codeOf(sb.register(host1, { t: "REGISTER", v: 1, name: "FIRST EXCH", region: "PORTLAND US", joshua: "period" }));
  assert.ok(code1);
  const code2 = sb.register(host2, { t: "REGISTER", v: 1, name: "SECOND EXCH", region: "SEATTLE US", joshua: "period" });
  // The board cap is checked before placement: a free slot in world 1 does not
  // make room on a full switchboard.
  assert.equal(code2, "full");
});

// ---- Switchboard: openChannel ------------------------------------------

test("Switchboard: openChannel returns 'offline' for unknown code", () => {
  const sb = new Switchboard();
  const client = fakePort();
  assert.equal(sb.openChannel("ZZZZZZ", client, ""), "offline");
});

test("Switchboard: openChannel returns 'busy' (not offline) when over maxChannels", () => {
  const sb = new Switchboard({ maxChannels: 1 });
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client1 = fakePort();
  const client2 = fakePort();
  const chan1 = sb.openChannel(code, client1, "");
  assert.equal(typeof chan1, "number");
  const chan2 = sb.openChannel(code, client2, "");
  assert.equal(chan2, "busy");
});

test("Switchboard: openChannel refuses an OPEN whose wrapped query overflows the trunk cap", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const openCount = () => host.sent.filter((d) => JSON.parse(d).t === "OPEN").length;
  // A query that only overflows once JSON-wrapped: escaping doubles every `"`.
  const result = sb.openChannel(code, fakePort(), '"'.repeat(TRUNK_MAX_FRAME_BYTES - 100));
  assert.equal(result, "oversize");
  assert.equal(openCount(), 0, "no OPEN may cross the trunk for a refused call");
  // The channel slot was not leaked half-open: a normal call still gets chan 1.
  assert.equal(sb.openChannel(code, fakePort(), "q=1"), 1);
  assert.equal(openCount(), 1);
});

test("Switchboard: openChannel sends OPEN to host and returns a chan id", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "q=1");
  assert.equal(chan, 1);
  assert.deepEqual(JSON.parse(host.sent[host.sent.length - 1]), { t: "OPEN", chan: 1, query: "q=1" });
});

// ---- Switchboard: relay both ways ------------------------------------------

test("Switchboard: clientFrame relays visitor -> host as FRAME", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.clientFrame(code, chan, "HELLO");
  const last = JSON.parse(host.sent[host.sent.length - 1]);
  assert.deepEqual(last, { t: "FRAME", chan, data: "HELLO" });
});

test("Switchboard: an escape-amplified client frame closes the call explicitly instead of a silent drop", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  // Legal raw size (< TRUNK_MAX_FRAME_BYTES), but JSON-escaping doubles every
  // `"`, pushing the wrapped FRAME past the trunk cap.
  const data = '"'.repeat(TRUNK_MAX_FRAME_BYTES - 100);
  sb.clientFrame(code, chan, data);
  assert.equal(client.closed, true);
  assert.equal(client.closeCode, 1009);
  assert.ok(client.closeReason && client.closeReason.length > 0, "close must carry an explicit reason");
  const frames = host.sent.map((d) => JSON.parse(d));
  assert.ok(!frames.some((f) => f.t === "FRAME"), "the oversize FRAME must not cross the trunk");
  const close = frames.find((f) => f.t === "CLOSE");
  assert.ok(close, "the host must be told the channel is gone (no half-open slot)");
  assert.equal(close.chan, chan);
  // The channel slot is freed hub-side too.
  const before = host.sent.length;
  sb.closeChannel(code, chan);
  assert.equal(host.sent.length, before);
});

test("Switchboard: handleHostFrame relays host -> client FRAME", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.handleHostFrame(code, { t: "FRAME", chan, data: "WORLD" });
  assert.deepEqual(client.sent, ["WORLD"]);
});

test("Switchboard: handleHostFrame CLOSE closes and drops the client channel", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.handleHostFrame(code, { t: "CLOSE", chan, reason: "call ended" });
  assert.equal(client.closed, true);
  // Channel is gone: closeChannel should be a no-op now (no further host send).
  const before = host.sent.length;
  sb.closeChannel(code, chan);
  assert.equal(host.sent.length, before);
});

test("Switchboard: handleHostFrame CLOSE propagates the host's reason to the visitor", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.handleHostFrame(code, { t: "CLOSE", chan, reason: "line busy" });
  assert.equal(client.closed, true);
  assert.equal(client.closeReason, "line busy");
});

test("Switchboard: handleHostFrame CLOSE without a reason falls back to 'call ended'", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.handleHostFrame(code, { t: "CLOSE", chan });
  assert.equal(client.closeReason, "call ended");
});

test("Switchboard: closeChannel sends CLOSE to host for a client-initiated hangup", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  const chan = sb.openChannel(code, client, "") as number;
  sb.closeChannel(code, chan);
  const last = JSON.parse(host.sent[host.sent.length - 1]);
  assert.deepEqual(last, { t: "CLOSE", chan });
});

// ---- Switchboard: request/response -----------------------------------------

test("Switchboard: request resolves on matching RESPONSE", async () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const p = sb.request(code, "GET", "/health", undefined);
  const sent = JSON.parse(host.sent[host.sent.length - 1]);
  assert.equal(sent.t, "REQUEST");
  assert.equal(sent.method, "GET");
  assert.equal(sent.path, "/health");
  sb.handleHostFrame(code, { t: "RESPONSE", rid: sent.rid, status: 200, body: "OK" });
  const result = await p;
  assert.deepEqual(result, { status: 200, body: "OK" });
});

test("Switchboard: request rejects with 'timeout' after timeoutMs", async () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  await assert.rejects(
    () => sb.request(code, "GET", "/health", undefined, 10),
    (err: unknown) => err === "timeout",
  );
});

test("Switchboard: an in-flight request rejects with 'dropped' (not 'offline') on unregister", async () => {
  // The exchange was live when it accepted the request and died mid-flight:
  // that is a gateway failure (502 at the REST relay), not an unknown code.
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const p = sb.request(code, "GET", "/health", undefined, 5000);
  sb.unregister(code);
  await assert.rejects(
    () => p,
    (err: unknown) => err === "dropped",
  );
});

test("Switchboard: request rejects with 'offline' for unknown code immediately", async () => {
  const sb = new Switchboard();
  await assert.rejects(
    () => sb.request("ZZZZZZ", "GET", "/health", undefined),
    (err: unknown) => err === "offline",
  );
});

// ---- Switchboard: unregister ------------------------------------------

test("Switchboard: unregister closes open channels and drops the exchange", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const client = fakePort();
  sb.openChannel(code, client, "");
  sb.unregister(code);
  assert.equal(client.closed, true);
  assert.equal(flatDir(sb, "https://hub.example").length, 0);
  // openChannel against a dropped code is now "unknown".
  assert.equal(sb.openChannel(code, fakePort(), ""), "offline");
});

// ---- Switchboard: directory ------------------------------------------

test("Switchboard: directory builds https api + wss link from a publicBase", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "claude", operator: "DANIEL" }));
  const dir = flatDir(sb, "https://hub");
  assert.equal(dir.length, 1);
  const entry = dir[0];
  assert.equal(entry.id, `trunk-${code.toLowerCase()}`);
  assert.equal(entry.name, "BASEMENT EXCH");
  assert.equal(entry.region, "PORTLAND US");
  assert.equal(entry.joshua, "claude");
  assert.equal(entry.operator, "DANIEL");
  assert.equal(entry.online, true);
  assert.equal(entry.api, `https://hub/x/${code}`);
  assert.equal(entry.link, `wss://hub/x/${code}/link`);
});

// ---- Switchboard: sweepDead / PONG liveness -------------------------------------

test("Switchboard: sweepDead unregisters after two missed pongs", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));

  let dropped = sb.sweepDead();
  assert.deepEqual(dropped, []);
  assert.equal(flatDir(sb, "https://hub").length, 1);

  dropped = sb.sweepDead();
  assert.deepEqual(dropped, [code]);
  assert.equal(flatDir(sb, "https://hub").length, 0);
});

test("Switchboard: a host PONG frame resets the missed-pong counter", () => {
  const sb = new Switchboard();
  const host = fakePort();
  const code = codeOf(sb.register(host, { t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));

  sb.sweepDead(); // missed = 1
  sb.handleHostFrame(code, { t: "PONG" }); // missed = 0, via the same path server.ts routes
  const dropped = sb.sweepDead(); // missed = 1, still alive
  assert.deepEqual(dropped, []);
  assert.equal(flatDir(sb, "https://hub").length, 1);
});
