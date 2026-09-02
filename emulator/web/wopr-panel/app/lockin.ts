// The panel's lock-in derivation — what the cabinet reads off the GTW feed
// (film-baseline S13: lamps agitate as DEFCON falls, the launch code locks in
// character by character, and at NO-WIN the search ends with the code
// complete and the launch aborted). Extracted from page.tsx so the reveal
// order is checkable by walking a GTW-FEED frame sequence under bare
// `node --test`, the same way app/feed.ts is: this module has no runtime
// imports (the feed type is erased), and no clock — every value is a pure
// function of the last complete feed message and the caller's tick.

import type { GtwFeed } from "./feed";

// The launch code WOPR brute-forces in the film — a documented production
// detail on the cabinet's readout, reproduced as a label, not dialogue.
//
// Unspaced, because the film's readout is unspaced (real-wopr#199). The
// grouped form CPE 1704 TKS read better while the code was half-resolved,
// which is a real argument for a cabinet surface — but codes.html and
// docs/surfaces.md publish the same string, and on-screen text is the
// fidelity contract (evals/film-baseline.md). Two surfaces disagreeing about
// one string was the worst of the three options.
export const CODE = "CPE1704TKS";

// How many of the code's 10 characters are locked at each DEFCON.
export const LOCKS_BY_DEFCON: Record<number, number> = { 5: 0, 4: 2, 3: 5, 2: 8, 1: 10 };

/** Deterministic avalanche hash — the panel's only source of "randomness". */
export function bits(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Indices of the code's non-space characters, in the scattered order the
// brute force locks them (fixed permutation, film-style non-sequential).
// The space filter is kept though CODE no longer has one: it is what makes
// "ten characters" a property of the code rather than of its formatting.
export const CODE_SLOTS = CODE.split("")
  .map((ch, i) => ({ ch, i }))
  .filter((s) => s.ch !== " ")
  .map((s) => s.i)
  .sort((a, b) => bits(a, 0, 777) - bits(b, 0, 777));

/** The only two feed fields the derivation reads. */
export type LockinInput = Pick<GtwFeed, "defcon" | "status">;

export interface Lockin {
  /** DEFCON shown on the board; 5 when nothing is being observed. */
  defcon: number;
  /** The routine reached NO-WIN: the search is over and the launch is off. */
  aborted: boolean;
  /** How many of CODE_SLOTS are locked, in CODE_SLOTS order. */
  locked: number;
}

/** What the readout and the DEFCON board show for the last complete feed
 *  message (null = standby). An abort locks the whole code at once — on film
 *  the search finishes as the machine gives up on winning. */
export function lockin(feed: LockinInput | null): Lockin {
  const defcon = feed?.defcon ?? 5;
  const aborted = feed?.status === "NO-WIN";
  const locked = aborted ? CODE_SLOTS.length : LOCKS_BY_DEFCON[defcon] ?? 0;
  return { defcon, aborted, locked };
}

export interface Agitation {
  /** Lamp-bank epoch for this tick: advances faster as DEFCON falls. */
  epoch: number;
  /** Percentage of lamps burning: more as DEFCON falls, more again at abort. */
  density: number;
}

/** Lamp agitation for one housekeeping tick of the derived state. */
export function agitation({ defcon, aborted }: Lockin, tick: number): Agitation {
  const epoch = Math.floor(tick / Math.max(1, defcon - (aborted ? 2 : 0)));
  const density = 16 + (5 - defcon) * 14 + (aborted ? 20 : 0);
  return { epoch, density };
}
