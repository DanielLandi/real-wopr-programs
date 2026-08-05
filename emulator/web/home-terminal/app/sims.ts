// Dial-in easter eggs (film-baseline S2/S9 and Rung 1/2/3 systems): the
// *other* numbers on David's paper list.
//
// Every dial target here is a real SYSTEM/1 system reached through the
// bridge (DialSystem / DIAL_SYSTEMS below), the same path WOPR itself dials.
// PACIFIC TELEPHONE was the last browser-sim placeholder (see git history
// for the old DialSim/LocalSimLink in-page surface); it and its siblings
// have all been promoted to real federated systems under systems/.

/** A real remote system reachable through the bridge's SYSTEM/1 path — the
 *  same session/link machinery WOPR itself uses (Rung 2/3). */
export interface DialSystem {
  kind: "system";
  id: string;
  name: string; // directory label
  number: string; // the ATDT number on the list
  systemId: string; // the bridge system id (POST /api/session { system })
}

export function isSystem(t: unknown): t is DialSystem {
  return !!t && (t as DialSystem).kind === "system";
}

import { DIALABLE_SYSTEMS } from "./dial-systems.generated.ts";

/** Editorial choices about the phone book — the only place a human writes a
 *  system id, and every one is checked against the generated list below.
 *
 *  `name` is the directory label, deliberately shorter than the manifest
 *  title ("SEATTLE SCHOOL DISTRICT", not "SEATTLE PUBLIC SCHOOL DISTRICT
 *  DATANET"). `label` is the wardial sweep's domain word. Order here is the
 *  order the directory prints. */
const LISTED: ReadonlyArray<{ systemId: string; name: string; label: string }> = [
  { systemId: "airline", name: "PAN AM / PANAMAC", label: "AIRLINE" },
  // The monitor, not the records program: school-mon owns the number and the
  // password prompt and hands the terminal to `school` (systems.md §2.6).
  { systemId: "school-mon", name: "SEATTLE SCHOOL DISTRICT", label: "SCHOOL DIST" },
  { systemId: "protovision", name: "PROTOVISION", label: "GAME CO" },
  { systemId: "pactel", name: "PACIFIC TELEPHONE", label: "TELCO" },
];

/** Dialable, but deliberately absent from the film's list of numbers. Stated
 *  so it reads as a decision rather than an omission. */
const UNLISTED: Readonly<Record<string, string>> = {
  reference: "the SYSTEM/1 reference implementation — not a system in the film",
};

/** Exposed only so a test can prove `UNLISTED` still says something — it has
 *  no other consumer, so an accidentally emptied table would otherwise be
 *  invisible to every test in this file. */
export const UNLISTED_SYSTEM_IDS: readonly string[] = Object.keys(UNLISTED);

const BY_ID = new Map(DIALABLE_SYSTEMS.map((s) => [s.systemId, s]));

for (const { systemId } of LISTED) {
  if (!BY_ID.has(systemId)) {
    throw new Error(
      `sims.ts lists "${systemId}", which is not a dialable system. ` +
        `Dialable ids come from systems/<id>/harness/manifest.json (a manifest ` +
        `with a "number"). Did a system get renamed or lose its number?`,
    );
  }
}
for (const systemId of Object.keys(UNLISTED)) {
  if (!BY_ID.has(systemId)) {
    throw new Error(`sims.ts excludes "${systemId}", which is not a dialable system.`);
  }
}

export const DIAL_SYSTEMS: DialSystem[] = LISTED.map(({ systemId, name }) => ({
  kind: "system",
  id: `sys-${systemId}`,
  name,
  number: BY_ID.get(systemId)!.number,
  systemId,
}));

/** systemId -> domain label for the wardial hit list (wardial.ts). */
export const WARDIAL_LABELS: Record<string, string> = Object.fromEntries(
  LISTED.map(({ systemId, label }) => [systemId, label]),
);
