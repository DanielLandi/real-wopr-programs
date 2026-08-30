// The callback, end to end, through the processes that actually ship (#76):
//
//   seat ⇄ hub relay ⇄ trunk ⇄ peer relay (tie line inside it) ⇄ bridge ⇄ Joshua
//
// Every one of those is the real thing, started the way `make host` and the
// flagship start it: two `node src/main.ts` relays configured by environment,
// the bridge under uvicorn with the scripted Joshua, the W.O.P.R. executive
// answering LOGON:. The only client code here is a handful of raw WebSocket
// envelopes — what a browser's crt-kit would send.
//
// Why it exists: four Criticals hid behind five green suites, because every
// suite stubbed the seam on its far side (#76). Three of the four are invisible
// to any test that does not send a line FROM the seat TO the program on an
// answered callback, which is step 6 below. So this walks the film beat and
// asserts on both directions of it:
//
//   1. a seat is held at the hub, and its token rides on a relayed dial
//   2. the dialogue reaches the Falken dossier
//   3. the visitor hangs up — and that close reaches the bridge, because
//   4. the bridge places the call (its `finally` is the trigger), over the
//      peer's tie line, and the operator's log says so
//   5. the hub rings the seat; the seat answers
//   6. frames cross both ways: Joshua greets, the seat types, Joshua replies
//   7. the seat hangs up, and the stack is whole enough to do it all again
//
// Deterministic by construction: fast mode (baud 0, no jitter), the scripted
// engine (no model, no clock), ephemeral ports. Under a minute — most of it
// is the bridge importing FastAPI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { resolve } from "node:path";
import { pythonFor } from "../../src/topology.ts";

const PACK = resolve(import.meta.dirname, "../../../..");
const VERBOSE = Boolean(process.env.WOPR_TEST_VERBOSE);
const INTERNAL_TOKEN = "peer-secret";

// --- processes ---------------------------------------------------------------

/** Everything a subprocess said, line by line, plus a way to wait for a line. */
interface Logged {
  proc: ChildProcess;
  lines: string[];
  until: (re: RegExp, ms?: number) => Promise<RegExpMatchArray>;
  stop: () => Promise<void>;
}

function spawnLogged(name: string, cmd: string, args: string[],
                     opts: { cwd: string; env: NodeJS.ProcessEnv }): Logged {
  const proc = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const waiters: Array<{ re: RegExp; resolve: (m: RegExpMatchArray) => void }> = [];
  for (const stream of [proc.stdout!, proc.stderr!]) {
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        if (VERBOSE) process.stderr.write(`${name.padEnd(8)} ${line}\n`);
        for (const w of waiters.splice(0)) {
          const m = line.match(w.re);
          if (m) w.resolve(m); else waiters.push(w);
        }
      }
    });
  }
  const until = (re: RegExp, ms = 30_000) => new Promise<RegExpMatchArray>((res, rej) => {
    for (const line of lines) { const m = line.match(re); if (m) { res(m); return; } }
    const timer = setTimeout(() => rej(new Error(
      `${name}: never printed ${re}; said:\n${lines.join("\n")}`)), ms);
    waiters.push({ re, resolve: (m) => { clearTimeout(timer); res(m); } });
  });
  const stop = () => new Promise<void>((res) => {
    if (proc.exitCode !== null) { res(); return; }
    proc.once("exit", () => res());
    proc.kill("SIGTERM");
    setTimeout(() => { if (proc.exitCode === null) proc.kill("SIGKILL"); }, 3_000).unref();
  });
  return { proc, lines, until, stop };
}

/** A port the OS has just handed out and released — the two ends that have
 *  to know each other's address before either exists (the bridge's
 *  BRIDGE_TRUNK_URL names the peer relay; the peer's BRIDGE_WS_URL names the
 *  bridge) are started on ports picked this way. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => res(port));
    });
  });
}

/** The environment a process gets: the caller's, minus anything that would
 *  make this stack something other than what the test declares — a developer's
 *  `.env` values for the flagship, an API key that would register the Claude
 *  engine, a database that would outlive the run. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(TRUNK_|TIELINE_|BRIDGE_|JOSHUA_|COMMS_|WOPR_RELAY_|WOPR_OPERATORS$|DATABASE_URL$|ANTHROPIC_API_KEY$)/.test(k)) continue;
    env[k] = v;
  }
  return env;
}

async function startRelay(name: string, env: NodeJS.ProcessEnv): Promise<Logged & { port: number }> {
  const relay = spawnLogged(name, "node", ["src/main.ts"], {
    cwd: `${PACK}/emulator/relay`,
    env: { ...scrubbedEnv(), COMMS_MODE: "fast", ...env },
  });
  const m = await relay.until(/^relay listening on :(\d+)/, 20_000);
  return Object.assign(relay, { port: Number(m[1]) });
}

async function startBridge(port: number, env: NodeJS.ProcessEnv): Promise<Logged> {
  const bridge = spawnLogged("bridge", pythonFor(PACK), [
    "-m", "uvicorn", "app.main:create_app", "--factory",
    "--host", "127.0.0.1", "--port", String(port),
  ], {
    cwd: `${PACK}/emulator/node`,
    env: { ...scrubbedEnv(), JOSHUA_ENGINE: "scripted", ...env },
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (bridge.proc.exitCode !== null) {
      throw new Error(`bridge exited (${bridge.proc.exitCode}):\n${bridge.lines.join("\n")}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/games`);
      if (r.ok) return bridge;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bridge never answered on :${port}:\n${bridge.lines.join("\n")}`);
}

// --- the client side ---------------------------------------------------------
//
// Raw envelopes over Node's own WebSocket, which is what the terminal's
// crt-kit sends once the fiction is peeled off. No `ws` here on purpose: this
// package does not depend on it, and the CLI job must still typecheck.

interface WsLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error",
                   fn: (ev: { data?: unknown; code?: number }) => void): void;
}
const WebSocketCtor = (globalThis as unknown as { WebSocket: new (url: string) => WsLike }).WebSocket;

interface Envelope {
  v: 1; session: string; seq: number; kind: string; link: string; payload: string; eom: boolean;
}

/** One line: every reassembled message the far end sent, by kind, and a
 *  poll for the next one that says a thing. Fragments (the shaper cuts a
 *  message into frame-sized pieces even at baud 0) are stitched by kind. */
class Line {
  readonly messages: Array<{ kind: string; text: string }> = [];
  closed = false;
  private readonly partial = new Map<string, string>();
  private cursor = 0;
  private readonly ws: WsLike;

  private constructor(ws: WsLike) {
    this.ws = ws;
    ws.addEventListener("message", (ev) => {
      let e: Envelope;
      try { e = JSON.parse(String(ev.data)) as Envelope; } catch { return; }
      const so_far = (this.partial.get(e.kind) ?? "") + e.payload;
      if (!e.eom) { this.partial.set(e.kind, so_far); return; }
      this.partial.delete(e.kind);
      this.messages.push({ kind: e.kind, text: so_far });
    });
    ws.addEventListener("close", () => { this.closed = true; });
  }

  static open(url: string): Promise<Line> {
    return new Promise((res, rej) => {
      const ws = new WebSocketCtor(url);
      ws.addEventListener("open", () => res(new Line(ws)));
      ws.addEventListener("error", () => rej(new Error(`could not open ${url}`)));
    });
  }

  send(kind: "input" | "control", payload: string, session = "client"): void {
    const e: Envelope = { v: 1, session, seq: 0, kind, link: "client", payload, eom: true };
    this.ws.send(JSON.stringify(e));
  }

  close(): void { this.ws.close(); }

  /** Everything of one kind, in order, whitespace flattened. */
  transcript(kind: string): string {
    return this.messages.filter((m) => m.kind === kind).map((m) => m.text).join("")
      .replace(/\s+/g, " ");
  }

  /** Wait for a message of `kind` containing `needle` that has NOT already
   *  been waited on — a cursor, so two identical greetings in a row are two
   *  events and not one. Returns that message's text. */
  async until(kind: string, needle: string, ms = 20_000): Promise<string> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      for (; this.cursor < this.messages.length; this.cursor++) {
        const m = this.messages[this.cursor]!;
        if (m.kind === kind && m.text.replace(/\s+/g, " ").includes(needle)) {
          this.cursor++;
          return m.text;
        }
      }
      if (this.closed) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never saw ${kind} ${JSON.stringify(needle)}` +
                    `${this.closed ? " (line closed)" : ""}; got: ${JSON.stringify(this.messages)}`);
  }
}

// --- the beat ----------------------------------------------------------------

test("the callback, end to end: seat -> hub -> trunk -> bridge -> Joshua and back",
     { timeout: 120_000 }, async (t) => {
  const bridgePort = await freePort();
  const peerPort = await freePort();

  // The hub: seats live here, calls are relayed from here, nothing is hosted
  // here. Its bridge URL is a closed port on purpose — a `/link` that landed
  // on the hub itself would be the wrong machine answering.
  const hub = await startRelay("hub", {
    COMMS_PORT: "0",
    BRIDGE_WS_URL: "ws://127.0.0.1:9",
    TRUNK_PUBLIC_BASE: "http://hub.invalid",
  });
  let bridge: Logged | undefined;
  let peer: (Logged & { port: number }) | undefined;
  try {
    // The bridge, as `make host` runs it: its own token, its trunk URL
    // pointing at ITS OWN relay (the peer), the scripted Joshua, in-memory
    // store. Started before the peer so the peer's session lookups have
    // somewhere to go from the first dial.
    bridge = await startBridge(bridgePort, {
      BRIDGE_INTERNAL_TOKEN: INTERNAL_TOKEN,
      BRIDGE_TRUNK_URL: `http://127.0.0.1:${peerPort}`,
    });
    // The peer: a relay that holds a tie line to the hub inside itself.
    peer = await startRelay("peer", {
      COMMS_PORT: String(peerPort),
      BRIDGE_WS_URL: `ws://127.0.0.1:${bridgePort}`,
      BRIDGE_INTERNAL_TOKEN: INTERNAL_TOKEN,
      TRUNK_HUB_URL: `ws://127.0.0.1:${hub.port}/trunk`,
      TIELINE_NAME: "BASEMENT EXCH",
      TIELINE_REGION: "PORTLAND US",
      TIELINE_SLOT: "PANAM",
    });
    const [, exchange] = await peer.until(/^TIE LINE UP .* EXCHANGE (\S+)$/);
    assert.match(exchange!, /^[A-Z2-9]{6}$/);

    // Twice, on the same stack: a stack that wedges on the first call's close
    // — a hub channel never freed, a peer leg never torn down, a seat hold
    // never released — cannot ring a second seat. The second pass is the
    // clean-close assertion for the first.
    let completed = 0;
    for (const pass of [1, 2]) {
      // A second pass after a failed first one is 20 seconds of the same
      // failure with less context, not a second finding.
      if (completed < pass - 1) break;
      await t.test(`pass ${pass}: the film beat`, async () => {
        // 1. David's desk holds a seat at the hub ...
        const seat = await Line.open(`ws://127.0.0.1:${hub.port}/seat?surface=home-terminal`);
        seat.send("control", "SEAT?");
        const seatToken = (await seat.until("control", "SEAT ")).split(" ")[1]!;

        // ... mints a session on the PEER's bridge through the hub's REST
        // relay (down the trunk, out of the tie line, into the real bridge) ...
        const post = await fetch(`http://127.0.0.1:${hub.port}/x/${exchange}/api/session`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface: "home-terminal" }),
        });
        const minted = await post.text();
        assert.equal(post.status, 201, minted);
        const { session_id, token } = JSON.parse(minted) as { session_id: string; token: string };

        // ... and dials the peer, carrying its seat token.
        const visitor = await Line.open(
          `ws://127.0.0.1:${hub.port}/x/${exchange}/link?surface=home-terminal` +
          `&session=${encodeURIComponent(session_id)}&token=${encodeURIComponent(token)}` +
          `&seat=${encodeURIComponent(seatToken)}`);
        await visitor.until("handshake", "CONNECTED");
        // The W.O.P.R. executive answers the line — a period program, not a
        // fixture.
        await visitor.until("output", "LOGON:");

        // 2. The dialogue reaches the Falken dossier.
        visitor.send("input", "JOSHUA", session_id);
        await visitor.until("output", "GREETINGS PROFESSOR FALKEN.");
        visitor.send("input", "IS FALKEN DEAD?", session_id);
        const dossier = await visitor.until("output", "GOOSE ISLAND, OREGON 97014");
        assert.match(dossier, /DR\. ROBERT HUME \(A\.K\.A\. STEPHEN W\. FALKEN\)/);

        // 3./4. The visitor hangs up. That close has to travel hub -> trunk ->
        // peer -> bridge, because the bridge's `finally` is what places the
        // call — and the peer's operator log is where a placement, or its
        // refusal, is announced.
        visitor.close();
        await peer!.until(/^CALLBACK PLACED — CHAN \d+$/, 20_000);
        assert.ok(!peer!.lines.some((l) => l.includes("CALLBACK NOT PLACED")),
          `a refusal was logged: ${peer!.lines.filter((l) => l.includes("CALLBACK")).join(" | ")}`);

        // 5. The hub rings the seat, naming the PEER's exchange, and the seat
        // answers.
        const ring = await seat.until("control", "RING ");
        assert.equal(ring, "RING BASEMENT EXCH");
        seat.send("control", "ANSWER", seatToken);

        // 6. Frames cross both ways. The answering leg is Joshua's, not a
        // front door: it greets, and the seat's typed line reaches the
        // program and is answered — the hop that dropped every `input` on
        // the floor before #71, and that no fake-socket test could see.
        await seat.until("output", "GREETINGS PROFESSOR FALKEN.");
        assert.ok(!seat.transcript("output").includes("LOGON:"),
          "the callback greeted with a front door, not Joshua");
        seat.send("input", "HELLO", seatToken);
        const reply = await seat.until("output", "HOW ARE YOU FEELING TODAY?");
        assert.ok(!reply.includes("--CONNECTION TERMINATED--"),
          "the typed line was rejected rather than answered");

        // 7. The seat hangs up. The only way a seat ends a call it answered
        // is by letting go of the seat itself, and that close has the whole
        // path to travel: hub channel, CLOSE on the trunk, the peer's local
        // leg, the bridge's socket. None of those ends announces itself, so
        // the proof that they all let go is the next pass: a fresh seat on
        // the same hub, peer and bridge, rung and answered again. (The
        // visitor's close at step 3 needs no such proof — the placement
        // itself is the bridge's `finally` having run.)
        seat.close();
        await new Promise((r) => setTimeout(r, 200));
        completed = pass;
      });
    }

    // Nothing on either relay's log complained on the way through.
    for (const [name, r] of [["hub", hub], ["peer", peer]] as const) {
      const bad = r.lines.filter((l) => /error|failed|refused|NOT PLACED/i.test(l));
      assert.deepEqual(bad, [], `${name} logged: ${bad.join(" | ")}`);
    }
  } finally {
    await peer?.stop();
    await bridge?.stop();
    await hub.stop();
  }
});
