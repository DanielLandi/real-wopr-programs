// Constraint-shaper tests (docs/comms-protocol.md §7): throughput, parity,
// toggle, plus envelope framing round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LinkShaper } from "../src/shaper.ts";
import { chunkPayload, reassemble, type Envelope } from "../src/envelope.ts";
import { DEFAULT_CONFIG, type LinkProfile } from "../src/config.ts";

const collect = () => {
  const frames: Envelope[] = [];
  return { frames, deliver: (e: Envelope) => frames.push(e) };
};

const done = (shaperFrames: Envelope[], expectedMessages: number) =>
  new Promise<void>((resolve) => {
    const tick = () => {
      if (shaperFrames.filter((f) => f.eom).length >= expectedMessages) resolve();
      else setTimeout(tick, 5);
    };
    tick();
  });

test("throughput: bytes are released at the profile's baud rate, not instantly", async () => {
  // 3000 baud / 10 bits-per-char = 300 chars/s. The bucket starts EMPTY (a
  // real line never bursts), so 450 bytes take ~1.5s end to end.
  const profile: LinkProfile = {
    baud: 3000, bits_per_char: 10, latency_ms: 0, jitter_ms: 0,
    frame_bytes: 30, handshake: "none",
  };
  const { frames, deliver } = collect();
  const shaper = new LinkShaper(profile, "test-3000", "s1", deliver);
  const payload = "X".repeat(450);
  const t0 = performance.now();
  shaper.send({ kind: "output", payload });
  await done(frames, 1);
  const elapsed = (performance.now() - t0) / 1000;
  shaper.close();

  assert.ok(elapsed >= 1.2, `finished too fast (${elapsed.toFixed(3)}s) — limitation not real`);
  assert.ok(elapsed <= 2.5, `took too long (${elapsed.toFixed(3)}s)`);
  assert.equal(reassemble(frames).join(""), payload);
  // Quantized emission: at least one envelope per frame, likely more.
  assert.ok(frames.length >= Math.ceil(450 / 30));
  assert.ok(frames.every((f, i) => f.seq === i));
});

test("parity: authentic and fast modes reassemble to identical bytes", async () => {
  const payload = "GREETINGS PROFESSOR FALKEN.\nSHALL WE PLAY A GAME?\n" + "A".repeat(200);
  const authentic: LinkProfile = {
    baud: 9600, bits_per_char: 10, latency_ms: 5, jitter_ms: 3,
    frame_bytes: 64, handshake: "none",
  };
  const off: LinkProfile = {
    baud: 0, bits_per_char: 10, latency_ms: 0, jitter_ms: 0,
    frame_bytes: 64, handshake: "none",
  };

  const a = collect();
  const sa = new LinkShaper(authentic, "leased-9600", "s1", a.deliver);
  sa.send({ kind: "output", payload });
  await done(a.frames, 1);
  sa.close();

  const f = collect();
  const sf = new LinkShaper(off, "off", "s1", f.deliver);
  sf.send({ kind: "output", payload });
  await done(f.frames, 1);
  sf.close();

  assert.deepEqual(reassemble(a.frames), reassemble(f.frames));
  // Fast mode still applies framing and envelopes (§6) — only timing differs.
  assert.equal(f.frames.length, a.frames.length);
  assert.ok(f.frames.length > 1);
  assert.ok(f.frames.every((fr, i) => fr.seq === i && fr.v === 1 && fr.link === "off"));
});

test("ordering: jitter never reorders frames", async () => {
  const profile: LinkProfile = {
    baud: 0, bits_per_char: 10, latency_ms: 10, jitter_ms: 10,
    frame_bytes: 8, handshake: "none",
  };
  const { frames, deliver } = collect();
  // Adversarial rng: alternate extreme jitter values.
  let i = 0;
  const rng = () => (i++ % 2 === 0 ? 0 : 1);
  const shaper = new LinkShaper(profile, "jittery", "s1", deliver, { rng });
  shaper.send({ kind: "output", payload: "ABCDEFGH".repeat(8) });
  await done(frames, 1);
  shaper.close();
  const seqs = frames.map((f) => f.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.equal(reassemble(frames)[0], "ABCDEFGH".repeat(8));
});

test("framing: a prompt is chunked like any other payload at dialup-300", async () => {
  // The shaper never inspects payload (§3), so a prompt gets the same trickle
  // output does — and a consumer that REPLACES rather than appends would keep
  // only the last quantum. This is the real home-terminal profile, so these
  // are the numbers the surfaces actually face.
  const { frames, deliver } = collect();
  const shaper = new LinkShaper(DEFAULT_CONFIG.profiles["dialup-300"],
                                "dialup-300", "s1", deliver);
  shaper.send({ kind: "prompt", payload: "[TTT]>" });
  await done(frames, 1);
  shaper.close();

  assert.ok(frames.length > 1, "a prompt that fits one frame would not prove the hazard");
  assert.equal(frames.filter((f) => f.eom).length, 1);
  assert.equal(frames.at(-1)!.eom, true);
  assert.ok(frames.every((f) => f.kind === "prompt"));
  assert.equal(reassemble(frames).join(""), "[TTT]>");
  // What a replacing consumer would have shown instead.
  assert.notEqual(frames.at(-1)!.payload, "[TTT]>");
});

test("framing: chunker respects byte width and multi-byte boundaries", () => {
  assert.deepEqual(chunkPayload("ABCDE", 2), ["AB", "CD", "E"]);
  assert.deepEqual(chunkPayload("", 64), [""]);
  // 3-byte code points never split mid-character.
  const chunks = chunkPayload("€€€", 4);
  assert.deepEqual(chunks, ["€", "€", "€"]);
});
