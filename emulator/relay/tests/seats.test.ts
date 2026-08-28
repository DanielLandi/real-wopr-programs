// Seat legs, handles, and rings. A handle is a CAPABILITY, not an identifier:
// it is minted per (seat, exchange), disclosed only to the exchange that
// earned it by being called, and dies with the leg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SeatRegistry } from "../src/seats.ts";
import { decodeEnvelope } from "../src/envelope.ts";
import { TRUNK_ALPHABET } from "../src/trunk.ts";

function fakeSeat() {
  const sent: string[] = [];
  let closed = false;
  return {
    sent, get closed() { return closed; },
    send: (d: string) => sent.push(d),
    close: () => { closed = true; },
  };
}

/** Deterministic ids and a timer the test drives by hand. */
function registry() {
  let n = 0;
  const timers: Array<{ ms: number; fn: () => void; cancelled: boolean }> = [];
  const reg = new SeatRegistry({
    newId: () => `ID${++n}`,
    setTimer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => { t.cancelled = true; };
    },
  });
  return { reg, timers, fire: () => { for (const t of timers) if (!t.cancelled) t.fn(); } };
}

test("seats: a leg is minted a token, and told it on connect", () => {
  const { reg } = registry();
  const port = fakeSeat();
  const { token } = reg.open(port, "home-terminal");
  const e = decodeEnvelope(port.sent[0]);
  assert.equal(e.kind, "control");
  assert.equal(e.payload, `SEAT ${token}`);
});

test("seats: a handle is minted on the first call and reused on the next", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  const first = reg.mint(token, "PANAM1");
  const second = reg.mint(token, "PANAM1");
  assert.equal(typeof first, "string");
  assert.equal(first, second, "one seat, one exchange, one handle");
});

test("seats: a second exchange gets a DIFFERENT handle for the same seat", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  assert.notEqual(reg.mint(token, "PANAM1"), reg.mint(token, "PROTO1"));
});

test("seats: one exchange's handle is refused when another presents it", () => {
  const { reg } = registry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  const handle = reg.mint(token, "PANAM1")!;
  assert.notEqual(reg.resolve(handle, "PANAM1"), "seat-gone");
  assert.equal(reg.resolve(handle, "PROTO1"), "seat-gone",
    "a handle is scoped to the machine that earned it");
});

test("seats: an unknown handle is refused exactly like a stolen one", () => {
  const { reg } = registry();
  assert.equal(reg.resolve("NOSUCH", "PANAM1"), "seat-gone");
});

test("seats: every handle dies with the leg", () => {
  const { reg } = registry();
  const { id, token } = reg.open(fakeSeat(), "home-terminal");
  const handle = reg.mint(token, "PANAM1")!;
  reg.close(id);
  assert.equal(reg.resolve(handle, "PANAM1"), "seat-gone");
  assert.equal(reg.byToken(token), undefined);
});

test("seats: a ring reaches the seat, and an answer stops the timer", () => {
  const { reg, timers, fire } = registry();
  const port = fakeSeat();
  const { id } = reg.open(port, "home-terminal");
  const seen: string[] = [];
  assert.equal(reg.ring(id, "PAN AM", {
    answered: () => seen.push("answered"),
    rejected: () => seen.push("rejected"),
    timedOut: () => seen.push("timedOut"),
  }), "ringing");
  assert.equal(decodeEnvelope(port.sent.at(-1)!).payload, "RING PAN AM");
  reg.answer(id);
  assert.deepEqual(seen, ["answered"]);
  fire();
  assert.deepEqual(seen, ["answered"], "an answered ring must not also time out");
  assert.equal(timers[0].ms, 30_000);
});

test("seats: a reject and a timeout each fire once", () => {
  const { reg, fire } = registry();
  const a = reg.open(fakeSeat(), "home-terminal");
  const seenA: string[] = [];
  reg.ring(a.id, "PAN AM", { answered: () => {}, rejected: () => seenA.push("rejected"), timedOut: () => seenA.push("timedOut") });
  reg.reject(a.id);
  fire();
  assert.deepEqual(seenA, ["rejected"]);

  const b = reg.open(fakeSeat(), "home-terminal");
  const seenB: string[] = [];
  reg.ring(b.id, "PAN AM", { answered: () => {}, rejected: () => {}, timedOut: () => seenB.push("timedOut") });
  fire();
  assert.deepEqual(seenB, ["timedOut"]);
});

test("seats: a seat that is ringing or on a call is busy", () => {
  const { reg } = registry();
  const { id } = reg.open(fakeSeat(), "home-terminal");
  const noop = { answered: () => {}, rejected: () => {}, timedOut: () => {} };
  assert.equal(reg.ring(id, "PAN AM", noop), "ringing");
  assert.equal(reg.ring(id, "PROTOVISION", noop), "busy");
  reg.answer(id);
  assert.equal(reg.ring(id, "PROTOVISION", noop), "busy");
  reg.release(id);
  assert.equal(reg.ring(id, "PROTOVISION", noop), "ringing");
});

test("seats: ringing an unknown leg is seat-gone", () => {
  const { reg } = registry();
  assert.equal(reg.ring("NOPE", "PAN AM", { answered: () => {}, rejected: () => {}, timedOut: () => {} }), "seat-gone");
});

test("seats: hold/release is a counter — a dialled leg's release must not clear an answered ring's hold", () => {
  // An answered ring and a leg that same seat dials out on (from the same
  // terminal, mid-conversation) each hold the seat independently. If a
  // holder is a flag rather than a count, the SECOND holder's release wipes
  // whatever the first one set — the seat goes ringable in the middle of a
  // live, answered call.
  const { reg } = registry();
  const { id } = reg.open(fakeSeat(), "home-terminal");
  const noop = { answered: () => {}, rejected: () => {}, timedOut: () => {} };
  reg.ring(id, "PAN AM", noop);
  reg.answer(id);           // holder #1: the answered call
  reg.hold(id);              // holder #2: a call this seat placed meanwhile
  reg.release(id);           // holder #2 lets go — its own call ended
  assert.equal(reg.ring(id, "PROTOVISION", noop), "busy",
    "the answered call's hold must survive an unrelated holder's release");
  reg.release(id);           // holder #1 lets go — the answered call ended
  assert.equal(reg.ring(id, "PROTOVISION", noop), "ringing",
    "once every holder has released, the seat is ringable again");
});

test("seats: default registry uses CSPRNG (source invariant check)", () => {
  // The guarantee is "this module's default generator is cryptographic". A revert to
  // Math.random() is the failure this test must catch. No behavioural assertion can
  // catch that revert — two generators indexed into TRUNK_ALPHABET produce identical
  // length-and-alphabet results. So pin the guarantee as a source invariant instead.
  const testDir = dirname(fileURLToPath(import.meta.url));
  const sourceFile = readFileSync(join(testDir, "../src/seats.ts"), "utf-8");
  assert.match(sourceFile, /randomBytes/, "source imports randomBytes from node:crypto");
  // Check that the randomId function uses randomBytes, not Math.random()
  // (look for the pattern that would indicate Math.random() usage: Math.random() * TRUNK_ALPHABET)
  assert.doesNotMatch(sourceFile, /Math\.random\(\)\s*\*\s*TRUNK_ALPHABET/, "randomId does not use Math.random()");
});

test("seats: default registry generates tokens from TRUNK_ALPHABET (26 chars)", () => {
  const reg = new SeatRegistry();
  const { token } = reg.open(fakeSeat(), "home-terminal");
  assert.equal(token.length, 26, "token is 26 characters (130 bits)");
  for (const ch of token) {
    assert.match(ch, /[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]/, `token char ${ch} is in TRUNK_ALPHABET`);
  }
});

test("seats: different seats get unique handles from the same exchange", () => {
  const reg = new SeatRegistry({
    newId: (() => { let n = 0; return () => `ID${++n}`; })(),
  });
  const { token: tokenA } = reg.open(fakeSeat(), "home-terminal");
  const { token: tokenB } = reg.open(fakeSeat(), "home-terminal");
  const handleA = reg.mint(tokenA, "PANAM1")!;  // PANAM1 spoke to seat A
  const handleB = reg.mint(tokenB, "PANAM1")!;  // PANAM1 also spoke to seat B
  // Handles are per-(seat, exchange), so same exchange gets different handles for different seats
  assert.notEqual(handleA, handleB, "same exchange gets unique handle per seat");
  // Both handles resolve correctly for PANAM1
  assert.notEqual(reg.resolve(handleA, "PANAM1"), "seat-gone", "PANAM1's handle to A resolves");
  assert.notEqual(reg.resolve(handleB, "PANAM1"), "seat-gone", "PANAM1's handle to B resolves");
});

test("seats: a handle minted before close cannot resolve after close", () => {
  const reg = new SeatRegistry({
    newId: (() => { let n = 0; return () => `ID${++n}`; })(),
  });
  const { id, token } = reg.open(fakeSeat(), "home-terminal");
  const handleA = reg.mint(token, "PANAM1")!;
  reg.close(id);
  // After close, a fresh mint on a different seat generates a fresh handle
  const { token: token2 } = reg.open(fakeSeat(), "home-terminal");
  const handleB = reg.mint(token2, "PANAM1")!;
  assert.notEqual(handleA, handleB, "fresh handle after close is different");
  assert.equal(reg.resolve(handleA, "PANAM1"), "seat-gone", "old handle is dead");
  assert.notEqual(reg.resolve(handleB, "PANAM1"), "seat-gone", "new handle works");
});

test("seats: close clears all handles from the index (not just via legs.get miss)", () => {
  // To prove handleIdx is actually purged, exploit the collision guard's semantics.
  // The failure (if handleIdx is not cleared) is visible: an exchange rings a seat
  // it never spoke to — a capability escape.
  let nextId = "A";
  const reg = new SeatRegistry({
    newId: () => nextId,
  });
  const { token: tokenA } = reg.open(fakeSeat(), "home-terminal");
  const handleA = reg.mint(tokenA, "PANAM1")!;

  // Close seat A. The collision guard now permits reusing the id because legs.delete(id) succeeded.
  reg.close("A");

  // Open a second leg whose newId returns the same id as the first. This is allowed
  // because the id is no longer in legs.
  nextId = "A";  // collision guard allows reuse of id
  const { token: tokenB } = reg.open(fakeSeat(), "home-terminal");

  // If close() did NOT purge handleIdx, the entry for handleA still points to id "A",
  // which now resolves to the NEW visitor's leg — a capability escape. Exchange PANAM1
  // rings a terminal it never spoke to.
  // If close() DID purge handleIdx, resolve returns "seat-gone".
  assert.equal(reg.resolve(handleA, "PANAM1"), "seat-gone",
    "old handle cannot escape to new leg when collision guard reuses the id");
});

test("seats: closing a leg mid-ring invokes timedOut on the handlers", () => {
  const { reg } = registry();
  const port = fakeSeat();
  const { id } = reg.open(port, "home-terminal");
  const seen: string[] = [];
  reg.ring(id, "PAN AM", {
    answered: () => seen.push("answered"),
    rejected: () => seen.push("rejected"),
    timedOut: () => seen.push("timedOut"),
  });
  // Close the seat mid-ring without answering or rejecting
  reg.close(id);
  assert.deepEqual(seen, ["timedOut"], "close invokes timedOut");
});

// ---- collision throws must never leak the colliding value (fix round 2) --

test("seats: an id collision's error message contains no id or token value", () => {
  // A newId that always returns the same value forces the FIRST check
  // (legs.has(id)) to fire on the second open().
  const reg = new SeatRegistry({ newId: () => "SAME" });
  const port = fakeSeat();
  reg.open(port, "home-terminal");
  assert.throws(
    () => reg.open(port, "home-terminal"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "seat id collision",
        "the message must name the case, and nothing else");
      assert.doesNotMatch(err.message, /SAME/);
      return true;
    },
  );
});

test("seats: a token collision's error message contains no id or token value", () => {
  // Distinct ids (ID1/ID2), but the second open()'s token reuses the first's —
  // forcing the SECOND check (byTokenIdx.has(token)) to fire.
  const seq = ["ID1", "TOK1", "ID2", "TOK1"];
  let i = 0;
  const reg = new SeatRegistry({ newId: () => seq[i++]! });
  const port = fakeSeat();
  reg.open(port, "home-terminal");
  assert.throws(
    () => reg.open(port, "home-terminal"),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, "seat token collision",
        "the message must name the case, and nothing else");
      assert.doesNotMatch(err.message, /TOK1/,
        "a live token must never appear in an error message — it is the one " +
        "credential this whole design exists to keep out of logs");
      return true;
    },
  );
});
