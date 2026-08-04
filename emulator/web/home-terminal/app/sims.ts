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

export const DIAL_SYSTEMS: DialSystem[] = [
  {
    kind: "system",
    id: "sys-airline",
    name: "PAN AM / PANAMAC",
    number: "(212) 555-0177",
    systemId: "airline",
  },
  {
    kind: "system",
    id: "sys-school",
    name: "SEATTLE SCHOOL DISTRICT",
    number: "(206) 555-0142",
    // The monitor, not the records program. The school was split in two
    // (docs/systems.md §2.6): `school-mon` owns the phone number and the
    // password prompt, and hands the terminal to `school` once you are in.
    // `school` has no `number` in its manifest any more, so it is not in the
    // dial-in phone book at all — naming it here would earn a 400 and print
    // SYSTEM UNREACHABLE on the film's own school dial.
    systemId: "school-mon",
  },
  {
    kind: "system",
    id: "sys-protovision",
    name: "PROTOVISION",
    number: "(408) 555-0163",
    systemId: "protovision",
  },
  {
    kind: "system",
    id: "sys-pactel",
    name: "PACIFIC TELEPHONE",
    number: "(311) 555-0100",
    systemId: "pactel",
  },
];
