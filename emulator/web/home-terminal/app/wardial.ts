import type { DialSystem } from "./sims";

export type SweepStatus = "CARRIER" | "NO CARRIER" | "BUSY";

export interface SweepHit {
  label: string;                 // "AIRLINE", "GAME CO", ... or "??? NO ANSWERBACK"
  target: DialSystem | null;     // a real system, or null = the unknown WOPR (dial(null))
}

export interface SweepEntry {
  number: string;                // dialed number as shown, e.g. "(408) 555-0148"
  status: SweepStatus;
  hit?: SweepHit;                // present iff status === "CARRIER"
}

/** systemId -> domain label for the hit list. */
const LABELS: Record<string, string> = {
  airline: "AIRLINE",
  school: "SCHOOL DIST",
  protovision: "GAME CO",
  pactel: "TELCO",
};

/** Fixed cosmetic misses (fabricated, no real trademarks), interleaved for
 *  texture. Order is stable. */
const MISSES: ReadonlyArray<{ number: string; status: SweepStatus }> = [
  { number: "(408) 555-0101", status: "NO CARRIER" },
  { number: "(408) 555-0117", status: "BUSY" },
  { number: "(408) 555-0125", status: "NO CARRIER" },
  { number: "(408) 555-0139", status: "NO CARRIER" },
  { number: "(408) 555-0151", status: "BUSY" },
  { number: "(408) 555-0168", status: "NO CARRIER" },
];

/** The unknown discovery: WOPR, dialed as an unlabeled carrier. target=null
 *  routes to dial(null) (the default bridge / (311) 399-2364 — 399 is one of
 *  the four Sunnyvale prefixes the operator reads out in the film; fidelity
 *  audit 2026-08-03, real-wopr#161). Kept in step with console.ts's
 *  DEFAULT_WOPR_NUMBER (a value, not an import: this module is data-only). */
const UNKNOWN: SweepEntry = {
  number: "(311) 399-2364",
  status: "CARRIER",
  hit: { label: "??? NO ANSWERBACK", target: null },
};

/** Deterministic sweep: real systems as labeled CARRIER hits + fixed misses +
 *  the unknown WOPR hit, in a stable order. Pure — no clock, no randomness. */
export function buildSweep(systems: DialSystem[]): SweepEntry[] {
  const hits: SweepEntry[] = systems.map((s) => ({
    number: s.number,
    status: "CARRIER" as const,
    hit: { label: LABELS[s.systemId] ?? "CARRIER", target: s },
  }));
  // Interleave misses and hits deterministically: miss, hit, miss, hit, ...
  // leftover misses appended; the unknown WOPR discovery comes last.
  const out: SweepEntry[] = [];
  const n = Math.max(MISSES.length, hits.length);
  for (let i = 0; i < n; i++) {
    if (i < MISSES.length) out.push({ ...MISSES[i] });
    if (i < hits.length) out.push(hits[i]);
  }
  out.push({ ...UNKNOWN });
  return out;
}

/** The film's own results header, printed over David's sweep results
 *  (fidelity audit 2026-08-03, real-wopr#161). */
export const RESULTS_HEADER = "NUMBERS FOR WHICH CARRIER TONES WERE DETECTED";

/** The reviewable hit list the sweep leaves behind: the completion line, the
 *  film's results header, the numbered carriers, and the DIAL hint. Pure, so
 *  the page just prints what this returns. */
export function hitListText(carriers: SweepEntry[]): string {
  const lines = [
    "",
    `SCAN COMPLETE - ${carriers.length} CARRIERS FOUND`,
    "",
    RESULTS_HEADER,
    "",
  ];
  carriers.forEach((e, idx) => {
    const label = e.hit?.target ? e.hit.target.name : "??? UNKNOWN SYSTEM";
    lines.push(`${String(idx + 1).padStart(2, "0")}  ${e.number}  ${label}  [${e.hit?.label}]`);
  });
  lines.push("", "DIAL <NN> TO CONNECT TO A CARRIER", "");
  return lines.join("\n");
}
