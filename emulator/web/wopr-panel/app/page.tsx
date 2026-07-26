"use client";
// WOPR Panel — the cabinet itself (film-baseline S11/S13; fidelity-notes.md
// §3: the prop's countdown panel was driven by an Apple II off-camera).
// A visualization surface like the Big Board: it observes whatever GTW state
// the bridge relays and renders the machine's face — banks of blinking
// lamps whose agitation follows DEFCON, and the launch-code readout whose
// characters lock in one by one as the crisis deepens (S13).
//
// All animation is derived from a deterministic integer hash of
// (position, epoch) — no unseeded randomness, same discipline as crt-kit's
// modem-noise LCG. With no live simulation the panel idles at DEFCON 5;
// RUN DEMO plays a self-contained escalation timeline.

import { useCallback, useEffect, useRef, useState } from "react";
import { CRTScreen, StatusPanel, WoprLink, endpointFromQuery, type LinkEvent } from "@real-wopr/crt-kit";
import { parseFeed, type GtwFeed } from "./feed";

const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Parse `?room=` against the bridge's room-code shape (exactly 6 characters
 *  from ROOM_ALPHABET — see normalize_room_code in the bridge). A malformed
 *  code is reported on-page instead of being forwarded to POST /api/session
 *  as an opaque 400. Deliberate per-surface duplicate: surface apps stay
 *  self-contained and share only the wire contract. */
function roomCodeFromLocation(): { code?: string; malformed?: string } {
  if (typeof window === "undefined") return {};
  const raw = new URLSearchParams(window.location.search).get("room");
  if (!raw) return {};
  const code = raw.trim().toUpperCase();
  const valid = code.length === 6 && [...code].every((ch) => ROOM_ALPHABET.includes(ch));
  return valid ? { code } : { malformed: code.slice(0, 24) };
}

const TICK_MS = 300;

// The launch code WOPR brute-forces in the film — a documented production
// detail on the cabinet's readout, reproduced as a label, not dialogue.
const CODE = "CPE 1704 TKS";
const CODE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// How many of the code's 10 characters are locked at each DEFCON.
const LOCKS_BY_DEFCON: Record<number, number> = { 5: 0, 4: 2, 3: 5, 2: 8, 1: 10 };

/** Deterministic avalanche hash — the panel's only source of "randomness". */
function bits(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

// Indices of the code's non-space characters, in the scattered order the
// brute force locks them (fixed permutation, film-style non-sequential).
const CODE_SLOTS = CODE.split("")
  .map((ch, i) => ({ ch, i }))
  .filter((s) => s.ch !== " ")
  .map((s) => s.i)
  .sort((a, b) => bits(a, 0, 777) - bits(b, 0, 777));

const LAMP_COLORS = ["#ffb000", "#ffb000", "#ffb000", "#ffb000", "#ffb000", "#ffb000", "#ff4040", "#ff4040", "#33ff66", "#e8e8d0"];

function LampBank({ rows, cols, epoch, density, bank }: {
  rows: number; cols: number; epoch: number; density: number; bank: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: "0.45em",
        border: "1px solid var(--crt-dim)",
        padding: "0.9em",
      }}
    >
      {Array.from({ length: rows * cols }, (_, i) => {
        const on = bits(i, epoch, bank) % 100 < density;
        const color = LAMP_COLORS[bits(i, 0, bank + 99) % LAMP_COLORS.length];
        return (
          <span
            key={i}
            style={{
              display: "block",
              aspectRatio: "1.6",
              background: color,
              opacity: on ? 0.95 : 0.1,
              boxShadow: on ? `0 0 8px ${color}` : "none",
            }}
          />
        );
      })}
    </div>
  );
}

function CodeReadout({ locked, epoch, aborted }: {
  locked: number; epoch: number; aborted: boolean;
}) {
  const lockedSet = new Set(CODE_SLOTS.slice(0, locked));
  const complete = locked >= CODE_SLOTS.length;
  return (
    <div style={{ border: "1px solid var(--crt-dim)", padding: "0.9em 1.2em", textAlign: "center" }}>
      <div style={{ letterSpacing: "0.3em", marginBottom: "0.4em" }}>LAUNCH CODE</div>
      <div style={{ fontSize: "2.6em", letterSpacing: "0.25em", whiteSpace: "nowrap" }}>
        {CODE.split("").map((ch, i) => {
          if (ch === " ") return <span key={i}> </span>;
          if (lockedSet.has(i)) {
            return (
              <span key={i} style={{ color: "#ff4040", textShadow: "0 0 10px #ff4040" }}>
                {ch}
              </span>
            );
          }
          const cycling = CODE_CHARSET[bits(i, epoch, 42) % CODE_CHARSET.length];
          return (
            <span key={i} style={{ opacity: 0.35 }}>
              {cycling}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: "0.4em", letterSpacing: "0.15em" }}>
        {aborted
          ? "WINNER: NONE — LAUNCH ABORTED"
          : complete
            ? "CODE COMPLETE — LAUNCH ENABLED"
            : `CODE SEARCH: ${locked}/${CODE_SLOTS.length} VERIFIED`}
      </div>
    </div>
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

// Demo escalation timeline, in ticks (300 ms each): DEFCON steps every 8 s,
// NO-WIN after 8 s at DEFCON 1, back to standby 8 s later.
const DEMO_STEP = Math.round(8000 / TICK_MS);

function demoFeed(t: number): GtwFeed | null {
  const phase = Math.floor(t / DEMO_STEP);
  if (phase >= 6) return null; // demo over — back to standby
  const defcon = Math.max(1, 5 - phase);
  const noWin = phase === 5;
  const secondsLeft = Math.max(0, Math.round(((5 - phase) * DEMO_STEP - (t % DEMO_STEP)) * (TICK_MS / 1000)));
  return {
    type: "gtw_state",
    defcon,
    clock: "--:--",
    targets: noWin ? 0 : (5 - defcon) * 12,
    impact: noWin ? null : `${String(Math.floor(secondsLeft / 60)).padStart(2, "0")}:${String(secondsLeft % 60).padStart(2, "0")}`,
    status: noWin ? "NO-WIN" : "EXERCISE",
    scenario: "EXERCISE — SELF PLAY",
    missiles: [],
  };
}

const buttonStyle = {
  background: "transparent",
  border: "1px solid var(--crt-dim)",
  color: "inherit",
  font: "inherit",
  textShadow: "inherit",
  padding: "0.2em 1em",
  cursor: "pointer",
  whiteSpace: "nowrap",
} as const;

export default function WoprPanel() {
  const [live, setLive] = useState<GtwFeed | null>(null);
  const [linkUp, setLinkUp] = useState(false);
  const [roomFault, setRoomFault] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [demoStart, setDemoStart] = useState<number | null>(null);
  const buffer = useRef("");
  const mounted = useRef(0);

  // Ticks are derived from elapsed time, not counted interval fires, so the
  // panel keeps true pace even when the browser throttles background tabs.
  useEffect(() => {
    mounted.current = performance.now();
    const t = setInterval(
      () => setTick(Math.floor((performance.now() - mounted.current) / TICK_MS)),
      TICK_MS,
    );
    return () => clearInterval(t);
  }, []);

  const onLinkEvent = useCallback((e: LinkEvent) => {
    if (e.type === "close") {
      setLinkUp(false);
      return;
    }
    if (e.type === "open") {
      setLinkUp(true);
      return;
    }
    if (e.type !== "frame") return;
    const f = e.frame;
    if (f.kind !== "output") return;
    buffer.current += f.payload;
    if (!f.eom) return;
    const message = buffer.current;
    buffer.current = "";
    const parsed = parseFeed(message);
    if (parsed) setLive(parsed);
  }, []);

  useEffect(() => {
    let link: WoprLink | null = null;
    let cancelled = false;
    (async () => {
      try {
        const room = roomCodeFromLocation();
        if (room.malformed !== undefined) {
          // Don't connect roomless when a room was asked for — surface the
          // bad code instead of an opaque 400 from the bridge.
          setRoomFault(room.malformed);
          return;
        }
        const apiBase = endpointFromQuery("api", process.env.NEXT_PUBLIC_API_URL) ?? "";
        const res = await fetch(`${apiBase}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ surface: "wopr-panel", room_code: room.code }),
        });
        if (!res.ok || cancelled) return;
        const s = (await res.json()) as { session_id: string; token: string };
        // A drop between a feed message's first and last chunk strands a
        // fragment that would otherwise prefix the next connection's first
        // message — here that corrupts a JSON parseFeed() call, not just a
        // cosmetic prefix, so it must not survive a reconnect.
        buffer.current = "";
        link = new WoprLink({
          url: endpointFromQuery("link", process.env.NEXT_PUBLIC_COMMS_URL),
          surface: "wopr-panel",
          session: s.session_id,
          token: s.token,
        });
        const l = link;
        link.onEvent((e) => {
          if (e.type === "open") l.sendInput("OBSERVE GTW");
          onLinkEvent(e);
        });
        link.connect();
      } catch {
        /* no exchange reachable — the panel idles; DEMO still works */
      }
    })();
    return () => {
      cancelled = true;
      link?.hangup();
    };
  }, [onLinkEvent]);

  // A live simulation always outranks the demo.
  const demo = !live && demoStart !== null ? demoFeed(tick - demoStart) : null;
  if (demoStart !== null && !live && demo === null) setDemoStart(null);
  const feed = live ?? demo;

  const defcon = feed?.defcon ?? 5;
  const aborted = feed?.status === "NO-WIN";
  const locked = aborted ? CODE_SLOTS.length : LOCKS_BY_DEFCON[defcon] ?? 0;
  // Lamp agitation: epochs advance faster and more lamps burn as DEFCON falls.
  const epoch = Math.floor(tick / Math.max(1, defcon - (aborted ? 2 : 0)));
  const density = 16 + (5 - defcon) * 14 + (aborted ? 20 : 0);

  return (
    <CRTScreen theme="green" flicker={false}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <StatusPanel
          items={[
            { label: "UNIT", value: "W.O.P.R." },
            { label: "MODE", value: feed ? feed.status : "STANDBY" },
            { label: "SCENARIO", value: feed?.scenario ?? "NONE" },
            { label: "IMPACT", value: feed?.impact ?? "--:--" },
            { label: "LINK", value: linkUp ? "BUS OK" : "DOWN" },
          ]}
        />
        {!live && demoStart === null && (
          <button style={{ ...buttonStyle, margin: "0 1em" }} onClick={() => setDemoStart(tick)}>
            RUN DEMO
          </button>
        )}
        <DefconBoard level={defcon} />
      </div>

      {roomFault !== null && (
        <div style={{ marginTop: "0.8em", letterSpacing: "0.1em", color: "#ffb000" }}>
          INVALID ROOM CODE &quot;{roomFault}&quot; — ROOM CODES ARE 6 CHARACTERS FROM {ROOM_ALPHABET}.
          CORRECT THE ?room= PARAMETER AND RELOAD.
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: "1.2em", marginTop: "1.2em" }}>
        <LampBank rows={5} cols={28} epoch={epoch} density={density} bank={1} />
        <div style={{ display: "flex", gap: "1.2em", alignItems: "stretch" }}>
          <div style={{ flex: 1 }}>
            <LampBank rows={6} cols={10} epoch={epoch} density={density} bank={2} />
          </div>
          <div style={{ flex: 2, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <CodeReadout locked={locked} epoch={tick} aborted={aborted} />
          </div>
          <div style={{ flex: 1 }}>
            <LampBank rows={6} cols={10} epoch={epoch} density={density} bank={3} />
          </div>
        </div>
        <LampBank rows={3} cols={28} epoch={epoch} density={Math.max(8, density - 10)} bank={4} />
      </div>
    </CRTScreen>
  );
}
