"use client";
// NORAD Big Board — the war-room command display (docs/surfaces.md §3).
// A visualization surface, not a command line: it listens on the uncapped
// internal-bus link and renders whatever GTW state the bridge relays.

import { useState } from "react";
import { CRTScreen, StatusPanel } from "@real-wopr/crt-kit";
import type { MovingTrack, TargetState } from "./feed";
import { ROOM_ALPHABET, useGtwFeed } from "./useGtwFeed";
import {
  CONTINENTS,
  POLAR_LAT_RIM,
  polylinePath,
  projectFor,
  projectPolar,
  trajectoryPath,
  trajectoryPoint,
  type MapMode,
} from "./worldmap";

const modeButtonStyle = {
  background: "transparent",
  border: "1px solid var(--crt-dim)",
  color: "inherit",
  font: "inherit",
  textShadow: "inherit",
  padding: "0.2em 0.8em",
  cursor: "pointer",
  whiteSpace: "nowrap",
  margin: "0 1em",
} as const;

/** Polar graticule: latitude rings + meridian spokes out to the disc rim.
 *  Ring radii are measured through projectPolar so they stay derived from
 *  the projection (the pole is the disc center; any meridian works). */
function PolarGraticule() {
  const [cx, cy] = projectPolar(0, 90);
  return (
    <g stroke="var(--crt-dim)" strokeWidth="0.4" opacity="0.35" fill="none">
      {[60, 30, 0, -30, POLAR_LAT_RIM].map((lat) => {
        const [x, y] = projectPolar(0, lat);
        return <circle key={lat} cx={cx} cy={cy} r={Math.hypot(x - cx, y - cy)} />;
      })}
      {Array.from({ length: 12 }, (_, i) => {
        const [x, y] = projectPolar(i * 30, POLAR_LAT_RIM);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} />;
      })}
    </g>
  );
}

function DefconBoard({ level }: { level: number }) {
  return (
    <div style={{ border: "1px solid var(--crt-dim)", padding: "0.4em 0.8em", textAlign: "center" }}>
      <div style={{ letterSpacing: "0.3em" }}>DEFCON</div>
      <div style={{ display: "flex", gap: "0.5em", fontSize: "1.6em" }}>
        {[5, 4, 3, 2, 1].map((n) => (
          <span
            key={n}
            style={{
              padding: "0 0.3em",
              border: "1px solid var(--crt-dim)",
              background: n === level ? "var(--crt-fg)" : "transparent",
              color: n === level ? "var(--crt-bg)" : "inherit",
              textShadow: n === level ? "none" : "inherit",
            }}
          >
            {n}
          </span>
        ))}
      </div>
    </div>
  );
}

function MovingMarker({
  track,
  mapMode,
  kind,
}: {
  track: MovingTrack;
  mapMode: MapMode;
  kind: "air" | "sea";
}) {
  const progress = Math.min(1, Math.max(0, track.progress));
  const [x, y] = trajectoryPoint(track.from, track.to, progress, mapMode);
  // This is a NORAD board, so the feed's side drives threat coloring: SU
  // tracks read warm/hostile, US tracks keep the cool per-kind color. The
  // marker glyph and dash pattern still distinguish air from sea.
  const color = track.side === "SU" ? "#ff8c5a" : kind === "air" ? "#66d9ff" : "#66ff99";
  // Track ids arrive pre-numbered (B-52-01, KIEV-01) — label with the id
  // as-is; re-appending an index double-numbered it ("B-52-01 01", #55).
  const label = track.id;
  return (
    <g>
      <path
        d={trajectoryPath(track.from, track.to, mapMode)}
        fill="none"
        stroke={color}
        strokeWidth={kind === "air" ? "0.8" : "0.6"}
        opacity={kind === "air" ? "0.55" : "0.4"}
        strokeDasharray={kind === "air" ? "4 5" : "2 7"}
      />
      {kind === "air" ? (
        <path
          d={`M ${x} ${y - 6} L ${x + 7} ${y + 6} L ${x} ${y + 3} L ${x - 7} ${y + 6} Z`}
          fill={color}
          opacity="0.9"
        />
      ) : (
        <path
          d={`M ${x - 8} ${y + 4} L ${x + 8} ${y + 4} L ${x + 4} ${y - 3} L ${x - 5} ${y - 3} Z`}
          fill={color}
          opacity="0.85"
        />
      )}
      <text x={x + 9} y={y + 5} fill={color} fontSize="12" letterSpacing="0.08em" opacity="0.85">
        {label}
      </text>
    </g>
  );
}

function TargetMarker({ target, mapMode }: { target: TargetState; mapMode: MapMode }) {
  const [x, y] = projectFor(mapMode)(target.position[0], target.position[1]);
  const color = target.status === "hit" ? "#ff5a5a" : "#ffd23c";
  return (
    <g>
      <circle cx={x} cy={y} r={7} fill="none" stroke={color} strokeWidth="1.2" />
      <line x1={x - 9} y1={y} x2={x + 9} y2={y} stroke={color} strokeWidth="1" />
      <line x1={x} y1={y - 9} x2={x} y2={y + 9} stroke={color} strokeWidth="1" />
      <text x={x + 11} y={y - 7} fill={color} fontSize="12" letterSpacing="0.08em">
        {target.name}
      </text>
    </g>
  );
}

export default function BigBoard() {
  const { feed, linkUp, roomFault } = useGtwFeed();
  const [mapMode, setMapMode] = useState<MapMode>("world");

  const defcon = feed?.defcon ?? 5;

  return (
    <CRTScreen theme="green" flicker={false}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <StatusPanel
          items={[
            { label: "STATUS", value: feed ? `SIMULATION ${feed.status}` : "STANDBY" },
            { label: "PHASE", value: (feed?.phase ?? "idle").toUpperCase() },
            { label: "SCENARIO", value: feed?.scenario ?? "NONE" },
            { label: "CLOCK", value: feed?.clock ?? "--:--" },
            { label: "TARGETS", value: String(feed?.targets ?? 0) },
            { label: "IMPACT", value: feed?.impact ?? "--:--" },
            { label: "LINK", value: linkUp ? "BUS OK" : "DOWN" },
          ]}
        />
        <button
          style={modeButtonStyle}
          onClick={() => setMapMode((m) => (m === "world" ? "polar" : "world"))}
        >
          MAP: {mapMode === "world" ? "WORLD" : "POLAR"}
        </button>
        <DefconBoard level={defcon} />
      </div>

      {roomFault !== null && (
        <div style={{ marginTop: "0.8em", letterSpacing: "0.1em", color: "#ffd23c" }}>
          INVALID ROOM CODE &quot;{roomFault}&quot; — ROOM CODES ARE 6 CHARACTERS FROM {ROOM_ALPHABET}.
          CORRECT THE ?room= PARAMETER AND RELOAD.
        </div>
      )}

      <svg
        viewBox="0 0 1000 500"
        style={{ width: "100%", height: "auto", marginTop: "1em" }}
        role="img"
        aria-label={mapMode === "world" ? "world map" : "polar map"}
      >
        {/* graticule */}
        {mapMode === "world" ? (
          <g>
            {Array.from({ length: 11 }, (_, i) => (
              <line key={`v${i}`} x1={i * 100} y1={0} x2={i * 100} y2={500}
                    stroke="var(--crt-dim)" strokeWidth="0.4" opacity="0.35" />
            ))}
            {Array.from({ length: 5 }, (_, i) => (
              <line key={`h${i}`} x1={0} y1={(i + 1) * 83.3} x2={1000} y2={(i + 1) * 83.3}
                    stroke="var(--crt-dim)" strokeWidth="0.4" opacity="0.35" />
            ))}
          </g>
        ) : (
          <PolarGraticule />
        )}
        {/* coastlines */}
        {CONTINENTS.map((poly, i) => (
          <path key={i} d={polylinePath(poly, mapMode)} fill="none"
                stroke="var(--crt-fg)" strokeWidth="1.1" opacity="0.85" />
        ))}
        {/* struck/warned targets */}
        {(feed?.targetStates ?? []).map((target) => (
          <TargetMarker key={`${target.name}-${target.status}`} target={target} mapMode={mapMode} />
        ))}
        {/* trajectories — multi-color, like the film's RGB-filtered vector
            art (fidelity-notes.md §3): red for strikes inbound to the US,
            amber for strikes inbound to the USSR. In polar mode they follow
            the true great circle — over the pole, through the disc center. */}
        {feed?.missiles.map((m, i) => {
          const inboundToUS = m.to[0] < -60;
          const color = inboundToUS ? "#ff5a5a" : "#ffd23c";
          const progress = Math.min(1, Math.max(0, m.progress));
          const [hx, hy] = trajectoryPoint(m.from, m.to, progress, mapMode);
          const [ix, iy] = projectFor(mapMode)(m.to[0], m.to[1]);
          return (
            <g key={i}>
              <path
                d={trajectoryPath(m.from, m.to, mapMode)}
                fill="none"
                stroke={color}
                strokeWidth="1.4"
                pathLength={1}
                strokeDasharray={`${progress} 1`}
              />
              <text
                x={hx + 10}
                y={hy - 8}
                fill={color}
                fontSize="15"
                letterSpacing="0.1em"
                opacity="0.9"
              >
                TRK {String(i + 1).padStart(2, "0")}
              </text>
              {m.progress >= 1 && (
                <circle cx={ix} cy={iy} r={5} fill={color}>
                  <animate attributeName="r" values="2;7;2" dur="1s" repeatCount="indefinite" />
                </circle>
              )}
            </g>
          );
        })}
        {/* aircraft and naval tracks — smaller than missile arcs so the
            primary GTW exchange still dominates the board. */}
        {(feed?.aircraft ?? []).map((track) => (
          <MovingMarker key={track.id} track={track} mapMode={mapMode} kind="air" />
        ))}
        {(feed?.ships ?? []).map((track) => (
          <MovingMarker key={track.id} track={track} mapMode={mapMode} kind="sea" />
        ))}
      </svg>

      {/* Event ticker — the feed's per-frame event lines (HIT/EXCHANGE/
          WINNER/ESTIMATED), the war-room readout under the map. The full
          screen-wall treatment is #38; this is the Big Board's own view. */}
      {(feed?.events?.length ?? 0) > 0 && (
        <div
          style={{
            marginTop: "0.8em",
            borderTop: "1px solid var(--crt-dim)",
            paddingTop: "0.5em",
            letterSpacing: "0.1em",
          }}
        >
          {(feed?.events ?? []).slice(-4).map((line, i) => (
            <div key={i} style={{ opacity: 0.85 }}>
              {line}
            </div>
          ))}
        </div>
      )}
    </CRTScreen>
  );
}
