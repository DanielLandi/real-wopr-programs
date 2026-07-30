// The Big Board's machine feed — the shape the bridge relays for a running
// GTW simulation (surfaces.md §3; deployment.md impact #3: bridge-relayed,
// never direct Supabase). Frames arrive as `output` envelopes whose payload
// is `GTW-FEED <json>` — text terminals observing the same session simply
// print the raw line, which is period-appropriate telemetry.

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

/** Structural mirror of a crt-kit link frame (spec-level duplicate on
 *  purpose, like the parser itself): keeping this module free of runtime
 *  imports is what lets bare `node --test` load it (real-wopr#123). */
export interface FeedFrame {
  kind: string;
  payload: string;
  eom: boolean;
}

/** The accumulate-until-eom half of the feed, extracted from useGtwFeed's
 *  frame handler so it is testable without a DOM. Feed messages arrive
 *  chunked by the link shaper; only a complete message may reach
 *  parseFeed() — a fragment stranded by a mid-message drop corrupts a JSON
 *  parse, not just a cosmetic prefix, so the hook calls reset() right
 *  before it constructs a new WoprLink. */
export class FeedAssembler {
  private buffer = "";

  /** Drop any fragment stranded by a mid-message carrier loss. */
  reset(): void {
    this.buffer = "";
  }

  /** Feed one frame; returns the parsed feed when a complete `output`
   *  message lands, null otherwise. Non-output frames — including the
   *  handshake ritual the internal bus does not have — are ignored and do
   *  not disturb the buffer. */
  push(f: FeedFrame): GtwFeed | null {
    if (f.kind !== "output") return null;
    this.buffer += f.payload;
    if (!f.eom) return null;
    const message = this.buffer;
    this.buffer = "";
    return parseFeed(message);
  }
}
