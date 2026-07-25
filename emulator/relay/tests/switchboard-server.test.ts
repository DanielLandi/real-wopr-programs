// Hub endpoints: /trunk (host registration), /x/<CODE>/link (visitor relay),
// GET /trunk/directory, and the allowlisted REST relay (trunk-federation
// spec, Task 2). `/link` itself is NOT touched here — its regression gate is
// server.test.ts continuing to pass unmodified.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { WebSocket } from "ws";
import { startServer } from "../src/server.ts";
import { TRUNK_MAX_FRAME_BYTES } from "../src/trunk.ts";

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

async function registerHost(base: string, wsBase: string): Promise<{ host: WebSocket; code: string }> {
  const host = await connect(`${wsBase}/trunk`);
  host.send(JSON.stringify({ t: "REGISTER", v: 1, name: "BASEMENT EXCH", region: "PORTLAND US", joshua: "period" }));
  const assigned = JSON.parse(await nextMessage(host));
  assert.equal(assigned.t, "ASSIGNED");
  return { host, code: assigned.exchange as string };
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
    assert.equal(dir.exchanges.length, 1);
    assert.equal(dir.exchanges[0].id, `trunk-${code.toLowerCase()}`);
    assert.equal(dir.exchanges[0].api, `${publicBase}/x/${code}`);
    assert.equal(dir.exchanges[0].link, `wss://hub.example/x/${code}/link`);
    host.close();
  } finally {
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
    assert.equal(dir.exchanges[0].api, `http://localhost:${server.port}/x/${code}`);
    assert.equal(dir.exchanges[0].link, `ws://localhost:${server.port}/x/${code}/link`);
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

test("trunk hub: visitor to unknown exchange code closes 4404 'exchange offline'", async () => {
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

test("trunk hub: visitor to a full exchange gets a distinct BUSY close, not 'offline'", async () => {
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
    assert.deepEqual(JSON.parse(resp.body), { exchanges: [] });
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

test("trunk hub: an oversize visitor frame closes the relay socket (1009) and never reaches the host", async () => {
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
    assert.equal(dir.exchanges.length, 1);

    host.close();
  } finally {
    await server.close();
  }
});

test("trunk hub: an oversize host frame at /trunk closes the socket (1009), hub stays alive", async () => {
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
    assert.deepEqual(dir.exchanges, []);
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

test("trunk hub: a /trunk socket that never REGISTERs is closed 4408 after the register timeout", async () => {
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
    assert.deepEqual(dir.exchanges, []);
  } finally {
    await server.close();
  }
});

test("trunk hub: an escape-amplified visitor frame closes the call explicitly, host sees CLOSE not FRAME", async () => {
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
    assert.equal(dir.exchanges.length, 1);
    host.close();
  } finally {
    await server.close();
  }
});
