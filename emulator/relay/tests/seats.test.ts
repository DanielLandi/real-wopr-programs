// Seat legs, handles, and rings. A handle is a CAPABILITY, not an identifier:
// it is minted per (seat, exchange), disclosed only to the exchange that
// earned it by being called, and dies with the leg.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SeatRegistry } from "../src/seats.ts";
import { decodeEnvelope } from "../src/envelope.ts";

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
