// The federation, end to end, over a real `wopr up`.
//
// These are slow on purpose: real relays, real node processes, real bwBASIC
// programs, real sockets. Everything else in the suite tests a piece; this
// tests the claim — that a program can ask another machine for something and
// get it, and that when the other machine is gone it says so instead of
// hanging.
//
// Every run is --fresh, so a store's memory never leaks between tests.

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { rmSync } from "node:fs";
import { loadTopology } from "../../src/topology.ts";
import { up, type Supervised } from "../../src/up.ts";
import { dial, type DialOpts } from "../../../terminal/src/protocol.ts";

type DialedLine = Awaited<ReturnType<typeof dial>>;

const PACK = resolve(import.meta.dirname, "../../../..");
const QUIET = (process.env.WOPR_TEST_VERBOSE
  ? process.stderr
  : { write: () => true }) as unknown as NodeJS.WritableStream;

let fed: Supervised;
let relays: Record<string, string>;

/**
 * Read from a line until `needle` shows up, or give up.
 *
 * Whitespace is flattened before matching. The shaper delivers a message as
 * byte-sized fragments so it arrives at the line\'s real rate, and a fragment
 * boundary lands wherever 64 bytes happen to fall — mid-word, mid-run of
 * spaces. Asserting on exact spacing would be asserting on the frame size.
 */
function flat(s: string): string {
  return s.replace(/\s+/g, " ");
}

type Tracked = DialedLine & {
  /** Every prompt seen so far, in arrival order — for debugging a timeout. */
  prompts: string[];
  /** Everything on the transcript (display text) so far. */
  transcript: () => string;
  /**
   * Wait for the *next* prompt this line has not yet asserted on, and
   * confirm it is exactly `text`.
   *
   * PASSWORD:, SELECT:, and the rest of the school's prompts arrive on the
   * prompt channel now, not in `line.output`'s display text (protocol.ts).
   * Equality, not substring: "STUDENT NAME:" is a substring of two different
   * prompts the school sends ("STUDENT NAME:" itself and "GRADE ENTRY -
   * STUDENT NAME:"), so substring matching would not actually confirm which
   * one arrived. A cursor (not "has this prompt ever appeared") matters too:
   * the school re-shows "SELECT:" more than once in a session, and a test
   * that re-dials the same already-seen prompt would pass without the far
   * end having said anything new.
   */
  untilPrompt: (text: string, ms?: number) => Promise<void>;
};

/**
 * Dial, and continuously drain everything the far end sends into two logs a
 * test can poll independently: `transcript()` for display text, `prompts`
 * for every prompt in arrival order.
 *
 * `line.output` is a single AsyncIterableIterator, and pulling on it is the
 * only thing that ever notices a prompt at all — protocol.ts's queue is one
 * FIFO for text and prompts both, and a prompt is processed (not yielded) as
 * a side effect of draining that queue. A single background pump owns that
 * pull for the life of the line, so every wait below is a plain poll of data
 * already collected, rather than juggling the live generator against a
 * per-call timeout (which is its own bug: a `.next()` call that processes a
 * prompt and then finds the queue empty does not resolve until more data
 * arrives, so racing it against a timeout can let a prompt that already
 * landed sit unnoticed until the whole wait times out).
 */
async function dialTracked(relay: string, address: string, opts: DialOpts = {}): Promise<Tracked> {
  const prompts: string[] = [];
  let text = "";
  let cursor = 0;
  const line = await dial(relay, address, { ...opts, onPrompt: (p) => prompts.push(p) });
  (async () => {
    for await (const chunk of line.output) text += chunk;
  })().catch(() => {});
  const untilPrompt = async (want: string, ms = 20_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (cursor < prompts.length) {
        const got = prompts[cursor++];
        if (got !== want) {
          throw new Error(`expected prompt ${JSON.stringify(want)}; got ${JSON.stringify(got)}`);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`never saw prompt ${JSON.stringify(want)}; prompts so far: ${JSON.stringify(prompts)}`);
  };
  return Object.assign(line, { prompts, transcript: () => text, untilPrompt });
}

/**
 * Poll a line's transcript until `needle` shows up, or give up.
 *
 * Whitespace is flattened before matching. The shaper delivers a message as
 * byte-sized fragments so it arrives at the line\'s real rate, and a fragment
 * boundary lands wherever 64 bytes happen to fall — mid-word, mid-run of
 * spaces. Asserting on exact spacing would be asserting on the frame size.
 */
async function until(line: Tracked, needle: string, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = line.transcript();
    if (flat(seen).includes(flat(needle))) return seen;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`never saw ${JSON.stringify(needle)}; got:\n${line.transcript()}`);
}

test("the federation, end to end", async (t) => {
  // Ordered on purpose: one of these kills school-db, and node:test will
  // happily run siblings concurrently — which sabotages whoever is still
  // reading from the store.
  rmSync(`${PACK}/.wopr`, { recursive: true, force: true });
  const topo = await loadTopology(PACK);
  fed = await up(PACK, topo, { fresh: true, out: QUIET });
  relays = Object.fromEntries(
    [...fed.relays].map(([name, r]) => [name, `ws://127.0.0.1:${r.port}`]));
  // Let every node claim its lines before anyone dials.
  await new Promise((r) => setTimeout(r, 3000));

  try {
  await t.test("every declared node that is a program is running", () => {
  for (const id of ["school", "school-db", "airline", "pactel", "protovision", "reference"]) {
    assert.ok(fed.nodes.has(id), `${id} was not started`);
  }
  // WOPR mounts others and needs the router; it is skipped, not faked.
  assert.equal(fed.nodes.has("wopr"), false);
});

  await t.test("dialling the school reaches the school", async () => {
  const line = await dialTracked(relays.pstn, "(206) 555-0142");
  await line.untilPrompt("PASSWORD:");
  assert.match(flat(line.transcript()), /GOOSE LAKE UNIFIED SCHOOL DISTRICT/);
  line.hangUp();
});

  await t.test("a phone number reaches the same line however it is punctuated", async () => {
  const line = await dialTracked(relays.pstn, "2065550142");
  await line.untilPrompt("PASSWORD:");
  line.hangUp();
});

  await t.test("asking for a record fetches it from another process", async () => {
  // The claim this whole sub-project exists to make good: these grades are not
  // in the school. They come out of school-db, across the bus.
  const line = await dialTracked(relays.pstn, "(206) 555-0142");
  await line.untilPrompt("PASSWORD:");
  line.send("PENCIL");
  await line.untilPrompt("SELECT:");
  line.send("1");
  await line.untilPrompt("STUDENT NAME:");
  line.send("LIGHTMAN");
  const seen = await until(line, "COMPUTER LAB");
  assert.match(flat(seen), /SEARCHING\.\.\./);
  assert.match(flat(seen), /STUDENT: LIGHTMAN, DAVID L\./);
  assert.match(flat(seen), /BIOLOGY 2 F/);
  line.hangUp();
});

  await t.test("a grade set on one call is there on the next — the store remembers", async () => {
  const first = await dialTracked(relays.pstn, "(206) 555-0142");
  await first.untilPrompt("PASSWORD:");
  first.send("PENCIL");
  await first.untilPrompt("SELECT:");
  first.send("2");
  await first.untilPrompt("GRADE ENTRY - STUDENT NAME:");
  first.send("LIGHTMAN");
  await first.untilPrompt("COURSE:");
  first.send("BIOLOGY 2");
  await first.untilPrompt("NEW GRADE:");
  first.send("A");
  await until(first, "RECORD UPDATED.");
  first.hangUp();

  // A separate call, and for the school a separate session entirely.
  const second = await dialTracked(relays.pstn, "(206) 555-0142");
  await second.untilPrompt("PASSWORD:");
  second.send("PENCIL");
  await second.untilPrompt("SELECT:");
  second.send("1");
  await second.untilPrompt("STUDENT NAME:");
  second.send("LIGHTMAN");
  const seen = await until(second, "COMPUTER LAB");
  assert.match(flat(seen), /BIOLOGY 2 A/, "the F->A change did not survive the call");
  second.hangUp();
});

  await t.test("a node answers on its second network too", async () => {
    // The capability the film's plot rests on: one machine reachable from two
    // networks at once. reference holds a phone number on pstn AND a hostname
    // on norad, and the same program answers on both.
    //
    // WOPR is meant to be *the* dual-homed machine — a bedroom phone line on
    // one side, the missiles on the other — but it has no period source yet,
    // so it is skipped rather than faked (#112). reference proves the runtime
    // can carry it.
    const overPhone = await dialTracked(relays.pstn, "(311) 555-0101");
    const a = await until(overPhone, "REFERENCE SYSTEM READY");
    overPhone.hangUp();

    const overNorad = await dialTracked(relays.norad, "REFERENCE");
    const b = await until(overNorad, "REFERENCE SYSTEM READY");
    overNorad.hangUp();

    assert.match(flat(a), /REFERENCE SYSTEM READY/);
    assert.match(flat(b), /REFERENCE SYSTEM READY/);
  });

  await t.test("the norad network is a different network, not an alias", async () => {
    // A hostname is not reachable on the phone network, and a phone number is
    // not reachable on norad. Two addresses, two networks, no crossover.
    const wrongNet = await dial(relays.norad, "(311) 555-0101");
    assert.equal(await wrongNet.closed, "NO ANSWER");

    const alsoWrong = await dial(relays.pstn, "REFERENCE");
    assert.equal(await alsoWrong.closed, "NO ANSWER");
  });

  await t.test("SCHOOL-DB is not reachable by anyone but the school", async () => {
  // callable_by travels with the registration and the relay enforces it, so a
  // caller cannot vouch for itself.
  const line = await dial(relays.bus, "SCHOOL-DB", { from: "airline" });
  assert.equal(await line.closed, "NO ANSWER");
});

  await t.test("a line nobody holds answers exactly like one you may not reach", async () => {
  // A failed dial must not tell a caller who exists.
  const nobody = await dial(relays.pstn, "(555) 555-5555");
  assert.equal(await nobody.closed, "NO ANSWER");
});

  await t.test("with the store gone, the school says so and keeps the line up", async () => {
  const line = await dialTracked(relays.pstn, "(206) 555-0142");
  await line.untilPrompt("PASSWORD:");
  line.send("PENCIL");
  await line.untilPrompt("SELECT:");

  // Take the records store away mid-call.
  fed.nodes.get("school-db")?.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  line.send("1");
  await line.untilPrompt("STUDENT NAME:");
  line.send("LIGHTMAN");
  // Wait for the menu, which comes *after* the message — reaching it at all
  // proves the line stayed up.
  const seen = await until(line, "RECORDS UNAVAILABLE");
  await line.untilPrompt("SELECT:");
  assert.match(flat(seen), /RECORDS UNAVAILABLE/);
  line.hangUp();
});
  } finally {
    await fed?.stop();
    rmSync(`${PACK}/.wopr`, { recursive: true, force: true });
  }
});
