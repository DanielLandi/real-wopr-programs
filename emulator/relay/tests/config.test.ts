// What rate each surface actually dials at.
//
// These are product decisions, not incidental config, and nothing used to pin
// them: `comms-protocol.md` §6 said the home terminal sat on `dialup-300`
// while DEFAULT_CONFIG put it on `dialup-1200`, and the two disagreed for
// weeks without a single test noticing. The mapping is cheap to assert, so
// assert it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG, resolveLink } from "../src/config.ts";
import { profileFor, type NetworkDescriptor } from "../src/network.ts";

test("the home terminal dials at 600 baud, with the full dial-up ritual", () => {
  const link = resolveLink(DEFAULT_CONFIG, "home-terminal");
  assert.ok(link, "home-terminal must resolve to a link");
  assert.equal(link.name, "dialup-600");
  assert.equal(link.profile.baud, 600);
  assert.equal(link.profile.handshake, "dialup");
  // ~60 char/s: the number every "how long does this take to paint" claim in
  // the docs is derived from.
  assert.equal(link.profile.baud / link.profile.bits_per_char, 60);
});

test("fast mode collapses the home terminal to `off` without losing the ritual's identity", () => {
  const fast = { ...DEFAULT_CONFIG, mode: "fast" as const };
  const link = resolveLink(fast, "home-terminal");
  assert.ok(link);
  assert.equal(link.name, "off");
  assert.equal(link.profile.baud, 0);
  // The ritual still belongs to the authentic link — only its timing collapses.
  assert.equal(link.authenticName, "dialup-600");
});

test("every surface_links target names a profile that exists", () => {
  for (const [surface, profile] of Object.entries(DEFAULT_CONFIG.surface_links)) {
    assert.ok(DEFAULT_CONFIG.profiles[profile],
      `surface ${surface} points at undefined profile ${profile}`);
  }
});

test("pack.json's dial-up network and the relay's profile table agree on the rate", () => {
  // The two legs a visitor can arrive on are configured in different files:
  // surface_links here, pack.json's network descriptors there. When they drift,
  // the same system answers at two different speeds depending on how it was
  // dialled — which is exactly the kind of thing nobody notices by hand.
  const pack = JSON.parse(readFileSync(new URL("../../../pack.json", import.meta.url), "utf8"));
  const pstn = pack.networks.pstn as NetworkDescriptor & { baud: number };
  assert.equal(pstn.baud, 600, "pack.json's pstn baud drifted from the home terminal's");

  const viaNetwork = profileFor({ ...pstn, name: "pstn" }, "authentic");
  const viaSurface = resolveLink(DEFAULT_CONFIG, "home-terminal")!.profile;
  assert.deepEqual(viaNetwork, viaSurface,
    "the /dial leg and the /link leg would shape the same call differently");
});
