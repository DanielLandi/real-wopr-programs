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
 *  routes to dial(null) (the default bridge / (311) 767-8524). */
const UNKNOWN: SweepEntry = {
  number: "(311) 767-8524",
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
