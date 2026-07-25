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
import { loadTopology } from "../src/topology.ts";
import { up, type Supervised } from "../src/up.ts";
import { dial } from "../../terminal/src/protocol.ts";

const PACK = resolve(import.meta.dirname, "../../..");
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

async function until(line: Awaited<ReturnType<typeof dial>>, needle: string, ms = 20_000) {
  let seen = "";
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      line.output.next(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))),
    ]);
    if (next.done) break;
    seen += next.value ?? "";
    if (flat(seen).includes(flat(needle))) return seen;
  }
  throw new Error(`never saw ${JSON.stringify(needle)}; got:\n${seen}`);
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
  const line = await dial(relays.pstn, "(206) 555-0142");
  const seen = await until(line, "PASSWORD:");
  assert.match(seen, /GOOSE LAKE UNIFIED SCHOOL DISTRICT/);
  line.hangUp();
});

  await t.test("a phone number reaches the same line however it is punctuated", async () => {
  const line = await dial(relays.pstn, "2065550142");
  await until(line, "PASSWORD:");
  line.hangUp();
});

  await t.test("asking for a record fetches it from another process", async () => {
  // The claim this whole sub-project exists to make good: these grades are not
  // in the school. They come out of school-db, across the bus.
  const line = await dial(relays.pstn, "(206) 555-0142");
  await until(line, "PASSWORD:");
  line.send("PENCIL");
  await until(line, "SELECT:");
  line.send("1");
  await until(line, "STUDENT NAME:");
  line.send("LIGHTMAN");
  const seen = await until(line, "COMPUTER LAB");
  assert.match(flat(seen), /SEARCHING\.\.\./);
  assert.match(flat(seen), /STUDENT: LIGHTMAN, DAVID L\./);
  assert.match(flat(seen), /BIOLOGY 2 F/);
  line.hangUp();
});

  await t.test("a grade set on one call is there on the next — the store remembers", async () => {
  const first = await dial(relays.pstn, "(206) 555-0142");
  await until(first, "PASSWORD:");
  first.send("PENCIL");
  await until(first, "SELECT:");
  first.send("2");
  await until(first, "STUDENT NAME:");
  first.send("LIGHTMAN");
  await until(first, "COURSE:");
  first.send("BIOLOGY 2");
  await until(first, "NEW GRADE:");
  first.send("A");
  await until(first, "RECORD UPDATED.");
  first.hangUp();

  // A separate call, and for the school a separate session entirely.
  const second = await dial(relays.pstn, "(206) 555-0142");
  await until(second, "PASSWORD:");
  second.send("PENCIL");
  await until(second, "SELECT:");
  second.send("1");
  await until(second, "STUDENT NAME:");
  second.send("LIGHTMAN");
  const seen = await until(second, "COMPUTER LAB");
  assert.match(flat(seen), /BIOLOGY 2 A/, "the F->A change did not survive the call");
  second.hangUp();
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
  const line = await dial(relays.pstn, "(206) 555-0142");
  await until(line, "PASSWORD:");
  line.send("PENCIL");
  await until(line, "SELECT:");

  // Take the records store away mid-call.
  fed.nodes.get("school-db")?.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 1500));

  line.send("1");
  await until(line, "STUDENT NAME:");
  line.send("LIGHTMAN");
  // Wait for the menu, which comes *after* the message — reaching it at all
  // proves the line stayed up.
  const seen = await until(line, "SELECT:");
  assert.match(flat(seen), /RECORDS UNAVAILABLE/);
  line.hangUp();
});
  } finally {
    await fed?.stop();
    rmSync(`${PACK}/.wopr`, { recursive: true, force: true });
  }
});
