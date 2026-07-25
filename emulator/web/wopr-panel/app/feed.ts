// The panel's machine feed — the same `GTW-FEED <json>` line the bridge
// relays to any observer of a running GTW simulation (surfaces.md;
// deployment.md impact #3: bridge-relayed, never direct Supabase). This is a
// deliberate duplicate of norad-bigboard's parser: surface apps stay
// self-contained and share only the wire contract.

export interface Missile {
  from: [number, number]; // [lon, lat]
  to: [number, number];
  progress: number; // 0..1
}

export interface MovingTrack extends Missile {
  id: string;
  side: "US" | "SU";
}

export interface TargetState {
  name: string;
  side: "US" | "SU";
  position: [number, number];
  status: "hit" | "warned" | "launched" | "aborted";
}

export interface GtwFeed {
  type: "gtw_state";
  phase?: "idle" | "selecting" | "running" | "no-win" | "aborted";
  defcon: number;
  clock: string; // simulation clock, e.g. "00:23"
  targets: number;
  impact: string | null; // countdown to first impact, e.g. "23:14"
  status: string; // PLAYING | NO-WIN | ...
  scenario: string; // e.g. "USSR FIRST STRIKE"
  missiles: Missile[];
  aircraft?: MovingTrack[];
  ships?: MovingTrack[];
  targetStates?: TargetState[];
  events?: string[];
}

export const FEED_PREFIX = "GTW-FEED ";

export function parseFeed(payload: string): GtwFeed | null {
  const line = payload.trim();
  if (!line.startsWith(FEED_PREFIX)) return null;
  try {
    const obj = JSON.parse(line.slice(FEED_PREFIX.length)) as GtwFeed;
    return obj.type === "gtw_state" ? obj : null;
  } catch {
    return null;
  }
}
