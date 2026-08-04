// The pre-connect command interpreter — David's IMSAI is keyboard-only, like
// a real 1983 micro. This module is PURE: (typed line + a context snapshot) ->
// an action descriptor. No React, no fetch, no clock — so it is unit-tested in
// console.test.mjs without a browser. The page (app/page.tsx) owns all effects
// (dialling, speech, montage timers); it just dispatches on `kind`.
//
// Federation note: this is a surface-local grammar. It shares only data shapes
// (Exchange/DialSystem/SweepEntry) with its siblings, never behaviour.

import type { DialSystem } from "./sims";
import type { Exchange } from "./exchanges";
import type { SweepEntry } from "./wardial";

/** Anything the terminal can dial: a registered exchange or a real remote
 *  SYSTEM/1 peer. `null` as a target means the default WOPR line — dial(null). */
export type DialTarget = Exchange | DialSystem;

/** The unknown carrier David found: WOPR's own number. Dialling it routes to
 *  the default bridge (dial(null)); it is also the ATDT fallback match.
 *  311-399-2364 — 399 is one of the four Sunnyvale prefixes the operator reads
 *  out in the film (fidelity audit 2026-08-03, real-wopr#161). */
export const DEFAULT_WOPR_NUMBER = "(311) 399-2364";

/** Everything the parser needs to resolve a line, snapshotted by the page. */
export interface ConsoleContext {
  /** The phone book, or null in classic single-exchange mode. */
  exchanges: Exchange[] | null;
  /** The known local SYSTEM/1 numbers (sims.ts DIAL_SYSTEMS). */
  systems: DialSystem[];
  /** A war-dial hit list, present only just after a WARDIAL sweep. When set,
   *  `DIAL <n>` indexes THIS list instead of the directory. */
  hits: SweepEntry[] | null;
}

/** One numbered line in the directory the user sees + dials by index/name. */
export interface DirEntry {
  index: number; // 1-based position printed as NN
  name: string;
  region?: string;
  number?: string; // the ATDT-dialable number, if the entry has one
  joshua?: "claude" | "period";
  world?: number; // trunk world, when the entry came from a trunk directory
  slot?: string;  // its role in that world (WOPR, SCHOOL, PANAM, ...)
  /** Bridge system id, when this slot is a period system rather than a Joshua
   *  line. Its presence is what tells the screen there is no Joshua here. */
  system?: string;
  target: DialTarget | null; // null = the default WOPR line
}

/** What the page should do with a parsed line. `dial` carries a resolved
 *  target (possibly null = default WOPR); everything printable carries text. */
export type ConsoleAction =
  | { kind: "help"; text: string }
  | { kind: "directory"; text: string }
  | { kind: "print"; text: string }
  | { kind: "dial"; target: DialTarget | null; label: string }
  | { kind: "scan" }
  | { kind: "wardial" }
  | { kind: "redial" }
  | { kind: "voice"; on: boolean }
  | { kind: "error"; text: string };

const HELP_TEXT = `COMMANDS:
  HELP  OR  ?         SHOW THIS LIST
  DIRECTORY           LIST KNOWN NUMBERS
  DIAL <NN>           DIAL A DIRECTORY ENTRY
  DIAL <NAME>         DIAL BY NAME
  ATDT <NUMBER>       DIAL A NUMBER DIRECTLY
  <NN> OR <NUMBER>    OR JUST TYPE THE NUMBER
  SCAN                SCAN EXCHANGES FOR A CARRIER
  WARDIAL             REPLAY DAVID'S WAR-DIAL SWEEP
  REDIAL              REDIAL THE LAST NUMBER
  VOICE ON | OFF      TOGGLE JOSHUA'S VOICE
`;

const digitsOf = (s: string): string => s.replace(/\D/g, "");

/** Build the POST /api/session body for a dial. A SYSTEM/1 peer is a
 *  point-to-point session and MUST NOT carry a room_code: the bridge rejects
 *  `system` + `room_code` with 400 "system sessions do not join rooms"
 *  (api-contract.md §2 — rooms are a WOPR-router coordination handle, and a
 *  system session never enters that router). Only exchange/WOPR dials carry the
 *  room. `systemId` is the peer's bridge id for a system dial, or null for an
 *  exchange/WOPR dial. Takes primitives (no sibling value import) so it stays a
 *  pure module console.test.mjs can guard without a browser. */
export function sessionBody(
  surface: string,
  roomCode: string | undefined,
  systemId: string | null,
  joshua?: string,
): Record<string, unknown> {
  // A system dial (PAN AM, SEATTLE SCHOOL) never reaches Joshua, so naming a
  // dialogue processor there is meaningless — and sending one would earn a 400
  // that the terminal can only report as the system being unreachable.
  if (systemId !== null) return { surface, system: systemId };
  const body: Record<string, unknown> = roomCode
    ? { surface, room_code: roomCode }
    : { surface };
  // Passed through unvalidated on purpose: which processors exist is the
  // exchange's business, and a surface that knew their names would be a second
  // place to keep in step. An exchange that cannot serve this one refuses.
  if (joshua) body.joshua = joshua;
  return body;
}

/** The canonical numbered directory: phone-book exchanges first, then the
 *  local SYSTEM/1 numbers, then the default WOPR line. Both DIRECTORY and
 *  DIAL-by-index/name resolve against this single ordered list.
 *
 *  One line per machine. A seeded world slot and a number on David's paper
 *  list (`DIAL_SYSTEMS`) can be the same box reached two ways — the school is
 *  both `SEATTLE SCHOOL DIST  SCHOOL` and `(206) 555-0142`. Where the
 *  exchange's bridge `system` id matches a local sim's `systemId`, the world
 *  entry ABSORBS the sim: it takes the sim's number (so `ATDT` off the paper
 *  list still lands) and the sim drops out of the standalone list. The world
 *  entry stays the target — in production both roads reach the same bridge,
 *  and the world's line is the canonical one.
 *
 *  The match is on the id alone, so the two sides have to be kept in step: the
 *  hub's seeded slot (`TRUNK_LOCAL_WORLD`, in the emulator README) and
 *  `sims.ts`'s `systemId`. Rename a system on one side only and it prints
 *  twice — not a defect in this function, which is why the README says so
 *  where the seed is actually written.
 *
 *  Nothing else changes: with no trunk directory loaded (local dev, classic
 *  mode) no sim matches and the list is exactly the pre-worlds one, an
 *  exchange without a `system` (a Joshua line: WOPR, CHEYENNE MOUNTAIN) can
 *  never match, and UNKNOWN — the mystery carrier, no systemId — is untouched.
 *  This is display/resolution only; sims.ts still owns the paper list, and
 *  WARDIAL sweeps `ctx.systems` directly, so its hit list keeps all four. */
export function directoryEntries(ctx: ConsoleContext): DirEntry[] {
  const out: DirEntry[] = [];
  let i = 1;
  const absorbed = new Set<DialSystem>();
  for (const e of ctx.exchanges ?? []) {
    const twin = e.system
      ? ctx.systems.find((s) => s.systemId === e.system && !absorbed.has(s))
      : undefined;
    if (twin) absorbed.add(twin);
    out.push({
      index: i++, name: e.name, region: e.region, joshua: e.joshua,
      world: e.world, slot: e.slot, system: e.system,
      number: twin?.number, target: e,
    });
  }
  for (const s of ctx.systems) {
    if (absorbed.has(s)) continue;
    out.push({ index: i++, name: s.name, number: s.number, target: s });
  }
  // The mystery carrier: David war-dialed this number without knowing what
  // answered. The directory must not spoil it — it identifies itself only once
  // you connect (LOGON: ... it's WOPR). Dial it by index, number, or "UNKNOWN".
  out.push({ index: i++, name: "UNKNOWN", number: DEFAULT_WOPR_NUMBER, target: null });
  return out;
}

/** The DIRECTORY screen as plain teletype text. Trunk entries arrive tagged
 *  with the world they were placed in, so they print under a `-- WORLD n --`
 *  heading; untagged entries (the local book, the SYSTEM/1 numbers, the
 *  mystery carrier) print exactly as they always did. */
export function directoryText(ctx: ConsoleContext): string {
  const lines = ["DIRECTORY", ""];
  let lastWorld: number | undefined;
  for (const e of directoryEntries(ctx)) {
    if (e.world !== undefined && e.world !== lastWorld) {
      if (lines.length > 2) lines.push("");
      lines.push(`-- WORLD ${e.world} --`);
      lastWorld = e.world;
    } else if (e.world === undefined && lastWorld !== undefined) {
      lines.push("");
      lastWorld = undefined;
    }
    // 80 columns, worst case, with every printed field at its maximum at once.
    // The number and the mode suffix are mutually exclusive: a number reaches
    // an exchange line only by absorbing a sim, which requires a `system` id,
    // and the suffix is suppressed on exactly those. So there are two ceilings,
    // and the taller one is the merged line:
    //   nn 2 + "  " 2 + name 24 + "  " 2 + slot 11 (PROTOVISION)
    //     + "  " 2 + number 14 ("(206) 555-0142")   =  57
    //   nn 2 + "  " 2 + name 24 + "  " 2 + slot 11 + " (1983 MODE)" 12  =  53
    // The REGISTER wire caps name at 24 and PROTOVISION is the longest roster
    // slot, so 57 is the true ceiling. The parenthesised suffix is delimited
    // by its own punctuation, so it takes a single leading space; the
    // name/slot and slot/number gaps keep two.
    //
    // An unabsorbed sim prints nn 2 + "  " 2 + name + "  " 2 + number 14; its
    // names are local constants (26 at the longest), so it never binds.
    //
    // The region used to print here as a ` [SAO PAULO BR]` suffix, and it was
    // what made 80 the binding constraint. It is no longer shown to a visitor
    // anywhere; DirEntry still carries it, because the wire still sends it.
    const nn = String(e.index).padStart(2, "0");
    const num = e.number ? `  ${e.number}` : "";
    // "(1983 MODE)" names the dialogue processor — period Lisp rather than
    // Claude. A slot that is a period SYSTEM (the school's BASIC-PLUS box, PAN
    // AM's reservations) never reaches Joshua at all, so the label would be
    // answering a question that line does not raise.
    const mode = e.joshua === "period" && !e.system ? " (1983 MODE)" : "";
    const slot = e.slot ? `  ${e.slot}` : "";
    lines.push(`${nn}  ${e.name}${slot}${num}${mode}`);
  }
  lines.push("");
  lines.push("DIAL <NN>   DIAL <NAME>   ATDT <NUMBER>   OR JUST THE NUMBER");
  return `${lines.join("\n")}\n`;
}

/** The opening screen after the IMSAI boot banner: directory + a HELP hint. */
export function initialText(ctx: ConsoleContext): string {
  return `\n${directoryText(ctx)}\nTYPE HELP FOR COMMANDS\n`;
}

function resolveDial(arg: string, ctx: ConsoleContext): ConsoleAction {
  if (!arg) return { kind: "error", text: "DIAL WHAT? TYPE DIRECTORY.\n" };

  if (/^\d+$/.test(arg)) {
    const n = parseInt(arg, 10);
    // After a war-dial, a bare number picks from the hit list, not the book.
    if (ctx.hits && ctx.hits.length > 0) {
      const hit = ctx.hits[n - 1];
      if (!hit) return { kind: "error", text: `NO ENTRY ${n} IN HIT LIST.\n` };
      const target = hit.hit ? hit.hit.target : null;
      const label = hit.hit?.target ? hit.hit.target.name : "UNKNOWN CARRIER";
      return { kind: "dial", target, label };
    }
    const entry = directoryEntries(ctx)[n - 1];
    if (!entry) {
      return { kind: "error", text: `NO ENTRY ${String(n).padStart(2, "0")} IN DIRECTORY.\n` };
    }
    return { kind: "dial", target: entry.target, label: entry.name };
  }

  // Case-insensitive prefix match over the directory (arg is already upper).
  const match = directoryEntries(ctx).find((e) => e.name.toUpperCase().startsWith(arg));
  if (match) return { kind: "dial", target: match.target, label: match.name };
  return { kind: "error", text: `NO DIRECTORY ENTRY MATCHING "${arg}". TYPE DIRECTORY.\n` };
}

function resolveAtdt(arg: string, ctx: ConsoleContext): ConsoleAction {
  const want = digitsOf(arg);
  if (!want) return { kind: "error", text: "ATDT WHAT NUMBER?\n" };
  // The default WOPR line and every numbered directory entry are candidates.
  const match = directoryEntries(ctx).find((e) => e.number && digitsOf(e.number) === want);
  if (match) return { kind: "dial", target: match.target, label: match.name };
  return { kind: "error", text: `NO CARRIER - ${arg.trim()} DOES NOT ANSWER.\n` };
}

/** Parse one typed line against the context snapshot. Case-insensitive and
 *  whitespace-trimmed; unknown input is a terse period error. Pure. */
export function parse(input: string, ctx: ConsoleContext): ConsoleAction {
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "print", text: "" };

  const upper = trimmed.toUpperCase();
  const sp = upper.indexOf(" ");
  const verb = sp === -1 ? upper : upper.slice(0, sp);
  const arg = sp === -1 ? "" : upper.slice(sp + 1).trim();

  switch (verb) {
    case "HELP":
    case "?":
      return { kind: "help", text: HELP_TEXT };
    case "DIRECTORY":
    case "DIR":
      return { kind: "directory", text: directoryText(ctx) };
    case "SCAN":
      return { kind: "scan" };
    case "WARDIAL":
    case "WAR-DIAL":
      return { kind: "wardial" };
    case "REDIAL":
      return { kind: "redial" };
    case "VOICE":
      if (arg === "ON") return { kind: "voice", on: true };
      if (arg === "OFF") return { kind: "voice", on: false };
      return { kind: "error", text: "USE VOICE ON  OR  VOICE OFF.\n" };
    case "DIAL":
      return resolveDial(arg, ctx);
    case "ATDT":
      return resolveAtdt(arg, ctx);
    default:
      // Bare-number dialing: a lone 1-2 digit token is a directory index (same
      // as DIAL <nn>, so it honours a war-dial hit list too); a longer
      // phone-number-shaped token (>=7 digits once () - . and spaces are
      // stripped) dials directly (same as ATDT <number>). Everything else —
      // including non-numeric unknowns — stays a terse HUH.
      if (/^\d{1,2}$/.test(trimmed)) return resolveDial(trimmed, ctx);
      if (/^[\d().\-\s]+$/.test(trimmed) && digitsOf(trimmed).length >= 7) {
        return resolveAtdt(trimmed, ctx);
      }
      return { kind: "error", text: `HUH? "${verb}" IS NOT A COMMAND. TYPE HELP.\n` };
  }
}
