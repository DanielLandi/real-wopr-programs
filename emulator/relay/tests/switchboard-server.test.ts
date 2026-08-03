// Hub endpoints: /trunk (host registration), /x/<CODE>/link (visitor relay),
// GET /trunk/directory, and the allowlisted REST relay (trunk-federation
// spec, Task 2). `/link` itself is NOT touched here — its regression gate is
// server.test.ts continuing to pass unmodified.
//
// World 1 is reserved by default (the flagship's), so a plain REGISTER now
// lands in world 2. Tests whose subject is placement or a refusal that
// reservation would pre-empt start their hub with
// `trunk: { reservedWorlds: [] }`; tests whose subject is directory or URL
// shape keep the default board and read the exchange out of world 2.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { decodeTrunkFrame, TRUNK_MAX_FRAME_BYTES, type TrunkFrame } from "../src/trunk.ts";

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(data.toString()));
    ws.once("error", reject);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

function httpJson(
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// The ASSIGNED reply is decoded with the real codec, not JSON.parse: the wire
// shape the hub emits has to satisfy decodeTrunkFrame's field checks, so a
// missing/ill-typed world or slot fails here rather than passing silently.
async function registerHost(
  base: string,
  wsBase: string,
  extra: Record<string, unknown> = {},
): Promise<{ host: WebSocket; code: string; world: number; slot: string }> {
  const host = await connect(`${wsBase}/trunk`);
  host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period", ...extra }));
  const decoded = decodeTrunkFrame(await nextMessage(host));
  assert.equal(decoded.t, "ASSIGNED");
  const assigned = decoded as Extract<TrunkFrame, { t: "ASSIGNED" }>;
  return { host, code: assigned.exchange, world: assigned.world, slot: assigned.slot };
}

test("trunk hub: register -> ASSIGNED -> directory lists the exchange with relayed URLs", async () => {
  // publicBase is configured explicitly here (as a real deployment would):
  // with port: 0 the server doesn't know its bound port until after listen,
  // so the default (http://localhost:<port>) can't reflect an ephemeral port.
  const publicBase = "https://hub.example";
  const server = await startServer({ port: 0, publicBase });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    // Default board: world 1 is reserved and stays empty, so the exchange is
    // listed under the world the hub actually opened for it.
    assert.deepEqual(dir.worlds.map((w: { n: number }) => w.n), [1, 2]);
    assert.deepEqual(dir.worlds[0], { n: 1, reserved: true, slots: [] });
    assert.equal(dir.worlds[1].slots.length, 1);
    assert.equal(dir.worlds[1].slots[0].id, `trunk-${code.toLowerCase()}`);
    assert.equal(dir.worlds[1].slots[0].api, `${publicBase}/x/${code}`);
    assert.equal(dir.worlds[1].slots[0].link, `wss://hub.example/x/${code}/link`);
    host.close();
  } finally {
    await server.close();
  }
});

// ---- world/slot placement over the wire ------------------------------------

test("trunk hub: slot collision opens world 2; explicit collision closes 4461", { timeout: 5000 }, async () => {
  // Subject: the collision refusal, not reservation — an open board, so the
  // explicit world 1 below is refused for the slot, not for being reserved.
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { slot: "WOPR" });
    assert.deepEqual([a.world, a.slot], [1, "WOPR"]);
    const b = await registerHost(base, wsBase, { slot: "WOPR" });
    assert.deepEqual([b.world, b.slot], [2, "WOPR"]);
    const c = await connect(`${wsBase}/trunk`);
    c.send(JSON.stringify({ t: "REGISTER", v: 1, name: "THIRD EXCH", region: "NOWHERE US", joshua: "period", world: 1, slot: "WOPR" }));
    const closed = await nextClose(c);
    assert.equal(closed.code, 4461);
    a.host.close(); b.host.close();
  } finally { await server.close(); }
});

test("trunk hub: maxWorlds cap closes 4460 no circuits", { timeout: 5000 }, async () => {
  // Subject: the cap. The single permitted world has to be placeable, so the
  // board is open — otherwise the first REGISTER is refused for reservation.
  const server = await startServer({ port: 0, trunk: { maxWorlds: 1, reservedWorlds: [] } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { slot: "WOPR" });
    const b = await connect(`${wsBase}/trunk`);
    b.send(JSON.stringify({ t: "REGISTER", v: 1, name: "SECOND EXCH", region: "NOWHERE US", joshua: "period", slot: "WOPR" }));
    assert.equal((await nextClose(b)).code, 4460);
    a.host.close();
  } finally { await server.close(); }
});

test("trunk hub: a full switchboard still closes 4409, distinct from a world refusal", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0, trunk: { maxExchanges: 1 } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { slot: "WOPR" });
    const b = await connect(`${wsBase}/trunk`);
    b.send(JSON.stringify({ t: "REGISTER", v: 1, name: "SECOND EXCH", region: "NOWHERE US", joshua: "period", slot: "SCHOOL" }));
    const closed = await nextClose(b);
    assert.equal(closed.code, 4409);
    assert.equal(closed.reason, "switchboard full");
    a.host.close();
  } finally { await server.close(); }
});

test("trunk hub: directory pins world 1 even when empty, and marks it reserved", async () => {
  const server = await startServer({ port: 0 });
  try {
    const res = await httpJson("GET", `http://127.0.0.1:${server.port}/trunk/directory`);
    assert.deepEqual(JSON.parse(res.body), { worlds: [{ n: 1, reserved: true, slots: [] }] });
  } finally { await server.close(); }
});

test("trunk hub: an unkeyed REGISTER for the reserved world closes 4462", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0 });
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const h = await connect(`${wsBase}/trunk`);
    h.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PRETENDER", region: "NOWHERE US", joshua: "period", world: 1, slot: "WOPR" }));
    const closed = await nextClose(h);
    assert.equal(closed.code, 4462);
    assert.equal(closed.reason, "world reserved");
    // Nothing was placed: the reserved world is still empty.
    const dir = JSON.parse((await httpJson("GET", `http://127.0.0.1:${server.port}/trunk/directory`)).body);
    assert.deepEqual(dir, { worlds: [{ n: 1, reserved: true, slots: [] }] });
  } finally { await server.close(); }
});

test("trunk hub: the reserve key claims the reserved world over the wire", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0, trunk: { reserveKey: "K" } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { key: "K", world: 1, slot: "WOPR" });
    assert.deepEqual([a.world, a.slot], [1, "WOPR"]);
    // The world stays flagged as reserved while it is occupied, and an
    // unkeyed caller is still refused — with 4462, not 4461: it must not
    // learn that WOPR is taken.
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.equal(dir.worlds[0].reserved, true);
    assert.deepEqual(dir.worlds[0].slots.map((s: { slot: string }) => s.slot), ["WOPR"]);
    const b = await connect(`${wsBase}/trunk`);
    b.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PRETENDER", region: "NOWHERE US", joshua: "period", world: 1, slot: "WOPR" }));
    assert.equal((await nextClose(b)).code, 4462);
    a.host.close();
  } finally { await server.close(); }
});

test("trunk hub: TRUNK_RESERVED_WORLDS and TRUNK_RESERVE_KEY configure the hub", { timeout: 5000 }, async () => {
  const beforeWorlds = process.env.TRUNK_RESERVED_WORLDS;
  const beforeKey = process.env.TRUNK_RESERVE_KEY;
  // "banana" and the empty token are dropped; world 2 is the one reserved, so
  // world 1 is placeable again and the overflow skips world 2 for world 3.
  process.env.TRUNK_RESERVED_WORLDS = "2, banana,,0";
  process.env.TRUNK_RESERVE_KEY = "ENV-KEY";
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { slot: "WOPR" });
    assert.equal(a.world, 1);
    const b = await registerHost(base, wsBase, { slot: "WOPR" });
    assert.equal(b.world, 3, "the overflow must skip the reserved world 2");
    const c = await connect(`${wsBase}/trunk`);
    c.send(JSON.stringify({ t: "REGISTER", v: 1, name: "PRETENDER", region: "NOWHERE US", joshua: "period", world: 2, slot: "SCHOOL" }));
    assert.equal((await nextClose(c)).code, 4462);
    const d = await registerHost(base, wsBase, { key: "ENV-KEY", world: 2, slot: "SCHOOL" });
    assert.deepEqual([d.world, d.slot], [2, "SCHOOL"]);
    a.host.close(); b.host.close(); d.host.close();
  } finally {
    if (beforeWorlds === undefined) delete process.env.TRUNK_RESERVED_WORLDS;
    else process.env.TRUNK_RESERVED_WORLDS = beforeWorlds;
    if (beforeKey === undefined) delete process.env.TRUNK_RESERVE_KEY;
    else process.env.TRUNK_RESERVE_KEY = beforeKey;
    await server.close();
  }
});

test("trunk hub: opts.trunk.reservedWorlds beats TRUNK_RESERVED_WORLDS", { timeout: 5000 }, async () => {
  const before = process.env.TRUNK_RESERVED_WORLDS;
  process.env.TRUNK_RESERVED_WORLDS = "1";
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { world: 1, slot: "WOPR" });
    assert.equal(a.world, 1);
    a.host.close();
  } finally {
    if (before === undefined) delete process.env.TRUNK_RESERVED_WORLDS;
    else process.env.TRUNK_RESERVED_WORLDS = before;
    await server.close();
  }
});

// Timeout, both env tests below: on regression the hub ACCEPTS the REGISTER
// instead of refusing it, so `nextClose` never settles and the test would hang
// forever rather than fail. The bound turns a regression into a red test.
test("trunk hub: a malformed TRUNK_MAX_WORLDS falls back to 8, it does not go unbounded", { timeout: 5000 }, async () => {
  // Number("banana") is NaN, and every `world > NaN` comparison is false — a
  // typo in the env var must not turn the explicit-world path into an
  // unbounded world allocator.
  const before = process.env.TRUNK_MAX_WORLDS;
  process.env.TRUNK_MAX_WORLDS = "banana";
  const server = await startServer({ port: 0 });
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const h = await connect(`${wsBase}/trunk`);
    h.send(JSON.stringify({ t: "REGISTER", v: 1, name: "FAR EXCH", region: "NOWHERE US", joshua: "period", world: 9, slot: "WOPR" }));
    assert.equal((await nextClose(h)).code, 4460);
  } finally {
    if (before === undefined) delete process.env.TRUNK_MAX_WORLDS;
    else process.env.TRUNK_MAX_WORLDS = before;
    await server.close();
  }
});

test("trunk hub: TRUNK_MAX_WORLDS caps the hub when opts.trunk does not", { timeout: 5000 }, async () => {
  const before = process.env.TRUNK_MAX_WORLDS;
  process.env.TRUNK_MAX_WORLDS = "1";
  // Subject: the env cap. maxWorlds stays unset in opts (that is the point);
  // the board is opened so the one permitted world can actually be filled.
  const server = await startServer({ port: 0, trunk: { reservedWorlds: [] } });
  const base = `http://127.0.0.1:${server.port}`, wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const a = await registerHost(base, wsBase, { slot: "WOPR" });
    const b = await connect(`${wsBase}/trunk`);
    b.send(JSON.stringify({ t: "REGISTER", v: 1, name: "SECOND EXCH", region: "NOWHERE US", joshua: "period", slot: "WOPR" }));
    assert.equal((await nextClose(b)).code, 4460);
    a.host.close();
  } finally {
    if (before === undefined) delete process.env.TRUNK_MAX_WORLDS;
    else process.env.TRUNK_MAX_WORLDS = before;
    await server.close();
  }
});

test("trunk hub: default publicBase reflects the post-listen bound port under port 0", async () => {
  // No explicit publicBase and no TRUNK_PUBLIC_BASE: the fallback must use the
  // port the server actually bound, not the pre-listen `0`.
  const before = process.env.TRUNK_PUBLIC_BASE;
  delete process.env.TRUNK_PUBLIC_BASE;
  const server = await startServer({ port: 0 });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const wsBase = `ws://127.0.0.1:${server.port}`;
    const { host, code } = await registerHost(base, wsBase);
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.equal(dir.worlds[1].slots[0].api, `http://localhost:${server.port}/x/${code}`);
    assert.equal(dir.worlds[1].slots[0].link, `ws://localhost:${server.port}/x/${code}/link`);
    host.close();
  } finally {
    if (before !== undefined) process.env.TRUNK_PUBLIC_BASE = before;
    await server.close();
  }
});

test("trunk hub: visitor relay carries OPEN query to host and FRAME both directions", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);

    const openPromise = nextMessage(host);
    const visitor = await connect(`${wsBase}/x/${code}/link?surface=home-terminal&session=s&token=t`);
    const open = JSON.parse(await openPromise);
    assert.equal(open.t, "OPEN");
    assert.equal(open.query, "surface=home-terminal&session=s&token=t");

    const visitorMsg = nextMessage(visitor);
    host.send(JSON.stringify({ t: "FRAME", chan: open.chan, data: "HELLO VISITOR" }));
    assert.equal(await visitorMsg, "HELLO VISITOR");

    const hostFrame = nextMessage(host);
    visitor.send("HELLO HOST");
    const frame = JSON.parse(await hostFrame);
    assert.equal(frame.t, "FRAME");
    assert.equal(frame.chan, open.chan);
    assert.equal(frame.data, "HELLO HOST");

    visitor.close();
    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: REST relay round-trips a POST through host RESPONSE", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);

    const reqPromise = nextMessage(host);
    const respPromise = httpJson("POST", `${base}/x/${code}/api/session`, JSON.stringify({ hello: "world" }));
    const req = JSON.parse(await reqPromise);
    assert.equal(req.t, "REQUEST");
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/api/session");
    assert.equal(req.body, JSON.stringify({ hello: "world" }));

    host.send(JSON.stringify({ t: "RESPONSE", rid: req.rid, status: 201, body: JSON.stringify({ ok: true }) }));
    const resp = await respPromise;
    assert.equal(resp.status, 201);
    assert.equal(resp.body, JSON.stringify({ ok: true }));

    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: non-allowlisted REST path returns 404", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const resp = await httpJson("GET", `${base}/x/${code}/api/nope`);
    assert.equal(resp.status, 404);
    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: visitor to unknown exchange code closes 4404 'exchange offline'", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0 });
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const visitor = await connect(`${wsBase}/x/ZZZZZZ/link?surface=home-terminal`);
    const closed = await nextClose(visitor);
    assert.equal(closed.code, 4404);
    assert.equal(closed.reason, "exchange offline");
  } finally {
    await server.close();
  }
});

test("trunk hub: visitor to a full exchange gets a distinct BUSY close, not 'offline'", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0, trunk: { maxChannels: 1 } });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const first = await connect(`${wsBase}/x/${code}/link?surface=home-terminal`);
    const second = await connect(`${wsBase}/x/${code}/link?surface=home-terminal`);
    const closed = await nextClose(second);
    assert.equal(closed.code, 4429);
    assert.equal(closed.reason, "exchange busy");
    assert.equal(first.readyState, WebSocket.OPEN, "the call that got the channel stays up");
    first.close();
    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: an aborted relay upload does not crash the hub", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    // Raw socket: declare a 100-byte body, send only part of it, then destroy
    // the connection mid-upload. The server's request stream errors; without
    // the guard, the rejection escapes handleHttp and kills the process.
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect(server.port, "127.0.0.1", () => {
        sock.write(
          "POST /x/ZZZZZZ/api/session HTTP/1.1\r\n" +
          "Host: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\n" +
          "Content-Length: 100\r\n" +
          "\r\n" +
          '{"partial":',
          () => {
            // Give the server a beat to start reading the body, then abort.
            setTimeout(() => { sock.destroy(); resolve(); }, 30);
          },
        );
      });
      sock.on("error", reject);
    });
    // Let the server-side stream error propagate before probing liveness.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resp = await httpJson("GET", `${base}/trunk/directory`);
    assert.equal(resp.status, 200);
    assert.deepEqual(JSON.parse(resp.body), { worlds: [{ n: 1, reserved: true, slots: [] }] });
  } finally {
    await server.close();
  }
});

test("trunk hub: REST relay rejects an oversize body with 413", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const resp = await httpJson("POST", `${base}/x/${code}/api/session`, "X".repeat(5000));
    assert.equal(resp.status, 413);
    host.close();
  } finally {
    await server.close();
  }
});

// ---- frame-size caps (hardening pass) --------------------------------------

test("trunk hub: an oversize visitor frame closes the relay socket (1009) and never reaches the host", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const openPromise = nextMessage(host);
    const visitor = await connect(`${wsBase}/x/${code}/link?surface=home-terminal&session=s&token=t`);
    await openPromise;

    let hostSawFrame = false;
    host.on("message", (data) => {
      const f = JSON.parse(data.toString());
      if (f.t === "FRAME") hostSawFrame = true;
    });

    visitor.send("X".repeat(TRUNK_MAX_FRAME_BYTES + 1));
    const closed = await nextClose(visitor);
    assert.equal(closed.code, 1009);
    // Give a beat for a (should-never-arrive) FRAME to reach the host.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hostSawFrame, false);

    // The hub itself stays alive: the directory still answers and the
    // exchange (unrelated to the visitor socket) is still registered.
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.equal(dir.worlds[1].slots.length, 1);

    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: an oversize host frame at /trunk closes the socket (1009), hub stays alive", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host } = await registerHost(base, wsBase);
    host.send("X".repeat(TRUNK_MAX_FRAME_BYTES + 512 + 1));
    const closed = await nextClose(host);
    assert.equal(closed.code, 1009);

    // Hub alive, and the dropped host's exchange is cleaned out of the directory.
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.deepEqual(dir.worlds, [{ n: 1, reserved: true, slots: [] }]);
  } finally {
    await server.close();
  }
});

// ---- relay keepalive (hardening pass) --------------------------------------

test("trunk hub: relayed visitor sockets get periodic pings (tunnel idle-timeout keepalive)", async () => {
  const server = await startServer({ port: 0, trunk: { relayPingMs: 20 } });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const visitor = await connect(`${wsBase}/x/${code}/link?surface=home-terminal&session=s&token=t`);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("no ping received")), 2000);
      visitor.once("ping", () => { clearTimeout(timeout); resolve(); });
    });
    visitor.close();
    host.close();
  } finally {
    await server.close();
  }
});

// ---- register-or-die timer (hardening pass) --------------------------------

test("trunk hub: a /trunk socket that never REGISTERs is closed 4408 after the register timeout", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0, trunk: { registerTimeoutMs: 20 } });
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const host = await connect(`${wsBase}/trunk`);
    const closed = await nextClose(host);
    assert.equal(closed.code, 4408);
  } finally {
    await server.close();
  }
});

test("trunk hub: REGISTERing inside the register-timeout window keeps the socket open", async () => {
  const server = await startServer({ port: 0, trunk: { registerTimeoutMs: 20 } });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host } = await registerHost(base, wsBase);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(host.readyState, WebSocket.OPEN);
    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: host disconnect empties the directory and 502s a queued request", async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const reqPromise = httpJson("GET", `${base}/x/${code}/api/games`);
    // Give the request a beat to reach the host frame's send queue, then drop the host.
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.close();

    // The exchange was live when it accepted the request: a mid-flight drop is
    // a gateway failure (502), distinct from an unknown code's 404.
    const resp = await reqPromise;
    assert.equal(resp.status, 502);

    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.deepEqual(dir.worlds, [{ n: 1, reserved: true, slots: [] }]);
  } finally {
    await server.close();
  }
});

test("trunk hub: an escape-amplified visitor frame closes the call explicitly, host sees CLOSE not FRAME", { timeout: 5000 }, async () => {
  const server = await startServer({ port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  try {
    const { host, code } = await registerHost(base, wsBase);
    const openPromise = nextMessage(host);
    const visitor = await connect(`${wsBase}/x/${code}/link?surface=home-terminal&session=s&token=t`);
    await openPromise;

    const seen: string[] = [];
    host.on("message", (data) => seen.push(JSON.parse(data.toString()).t as string));

    // Raw size is legal (< TRUNK_MAX_FRAME_BYTES, passes the ws-level cap),
    // but JSON-escaping doubles every `"` when the hub wraps it as FRAME.data.
    visitor.send('"'.repeat(TRUNK_MAX_FRAME_BYTES - 100));
    const closed = await nextClose(visitor);
    assert.equal(closed.code, 1009);
    assert.ok(closed.reason.length > 0, "close must carry an explicit reason");

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(!seen.includes("FRAME"), "the oversize FRAME must never cross the trunk");
    assert.ok(seen.includes("CLOSE"), "the host must be told the channel is gone");

    // Hub still alive.
    const dir = JSON.parse((await httpJson("GET", `${base}/trunk/directory`)).body);
    assert.equal(dir.worlds[1].slots.length, 1);
    host.close();
  } finally {
    await server.close();
  }
});
