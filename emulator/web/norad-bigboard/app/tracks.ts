// Pure row model for the TACTICAL TRACKS monitor (screen-wall bezel, #39).
// Deliberate spec-level cousin of the bridge's TRACKS teletype table — the
// two share only the GTW-FEED wire shape, per the federation boundary.

import type { GtwFeed } from "./feed";

export interface TrackRow {
  id: string;
  typ: "AC" | "SHIP" | "MSL";
  side: string;
  from: [number, number];
  to: [number, number];
  progress: number;
}

export function trackRows(feed: GtwFeed): TrackRow[] {
  const rows: TrackRow[] = [];
  for (const t of feed.aircraft ?? []) {
    rows.push({ id: t.id, typ: "AC", side: t.side, from: t.from, to: t.to, progress: t.progress });
  }
  for (const t of feed.ships ?? []) {
    rows.push({ id: t.id, typ: "SHIP", side: t.side, from: t.from, to: t.to, progress: t.progress });
  }
  (feed.missiles ?? []).forEach((m, i) => {
    rows.push({
      id: `MSL-${String(i + 1).padStart(2, "0")}`,
      typ: "MSL", side: "", from: m.from, to: m.to, progress: m.progress,
    });
  });
  return rows;
}

export function targetLine(feed: GtwFeed): string | null {
  const targets = feed.targetStates ?? [];
  if (targets.length === 0) return null;
  return "TARGETS: " + targets.map((t) => `${t.name} ${t.status.toUpperCase()}`).join("  ");
}
