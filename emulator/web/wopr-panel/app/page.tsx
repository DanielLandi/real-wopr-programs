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
import { FeedAssembler, type GtwFeed } from "./feed";
import { CODE, CODE_SLOTS, agitation, bits, lockin } from "./lockin";
import { boardAt, gamesCompleted, GAMES, NOWIN_VERDICT, type Board } from "./selfplay";

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

// The code, its lock order and the lock-in derivation live in app/lockin.ts
// so the S13 reveal order is testable without a browser.
const CODE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

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

// The brute force spins far faster than the panel's 300 ms housekeeping tick —
// on film the unsolved characters are a blur. Own clock, same time-derived
// deterministic discipline as the main tick.
const CODE_TICK_MS = 50;

function CodeReadout({ locked, aborted }: {
  locked: number; aborted: boolean;
}) {
  const lockedSet = new Set(CODE_SLOTS.slice(0, locked));
  const complete = locked >= CODE_SLOTS.length;
  const [epoch, setEpoch] = useState(0);
  const born = useRef(0);
  useEffect(() => {
    if (complete || aborted) return;
    born.current = born.current || performance.now();
    const t = setInterval(
      () => setEpoch(Math.floor((performance.now() - born.current) / CODE_TICK_MS)),
      CODE_TICK_MS,
    );
    return () => clearInterval(t);
  }, [complete, aborted]);
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

/** One 3x3 grid, drawn as a board rather than as text so it reads at a glance
 *  while the bank is cycling. */
function TicTacToe({ board }: { board: Board }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(3, 1fr)",
        gap: "1px",
        background: "var(--crt-dim)",
        border: "1px solid var(--crt-dim)",
        aspectRatio: "1",
      }}
    >
      {board.map((cell, i) => (
        <span
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--crt-bg)",
            fontSize: "1.1em",
            lineHeight: 1,
            color: cell === "X" ? "#ffb000" : "#33ff66",
            textShadow: cell === " " ? "none" : "0 0 6px currentColor",
          }}
        >
          {cell}
        </span>
      ))}
    </div>
  );
}

/** S14: the machine plays itself and nothing comes of it. Nine real minimax
 *  games cycling out of phase — every one a draw, which is why the tally can
 *  only ever read WINNER: NONE. */
function SelfPlayBank({ tick }: { tick: number }) {
  return (
    <div style={{ border: "1px solid var(--crt-dim)", padding: "0.9em" }}>
      <div style={{ display: "flex", justifyContent: "space-between", letterSpacing: "0.2em" }}>
        <span>TIC-TAC-TOE — SELF PLAY</span>
        <span>GAMES: {gamesCompleted(tick)} &nbsp; WINNER: NONE</span>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${GAMES.length}, 1fr)`,
          gap: "0.7em",
          marginTop: "0.7em",
        }}
      >
        {GAMES.map((_, g) => (
          <TicTacToe key={g} board={boardAt(g, tick)} />
        ))}
      </div>
      <div style={{ marginTop: "0.7em", letterSpacing: "0.15em", opacity: 0.85 }}>
        {NOWIN_VERDICT}
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
// NO-WIN after 8 s at DEFCON 1, then two steps of the S14 lesson before the
// panel returns to standby. The lesson gets 16 s because it is the point of
// the scene, not a transition out of it.
const DEMO_STEP = Math.round(8000 / TICK_MS);

function demoFeed(t: number): GtwFeed | null {
  const phase = Math.floor(t / DEMO_STEP);
  if (phase >= 7) return null; // demo over — back to standby
  const defcon = Math.max(1, 5 - phase);
  const noWin = phase >= 5;
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
  const [lessonStart, setLessonStart] = useState<number | null>(null);
  // The DOM-free accumulate-until-eom core (app/feed.ts): only a complete
  // message may reach parseFeed().
  const assembler = useRef<FeedAssembler | null>(null);
  if (assembler.current === null) assembler.current = new FeedAssembler();
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
    const parsed = assembler.current?.push(e.frame) ?? null;
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
        assembler.current?.reset();
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

  const lock = lockin(feed);
  const { defcon, aborted, locked } = lock;
  // Lamp agitation: epochs advance faster and more lamps burn as DEFCON falls.
  const { epoch, density } = agitation(lock, tick);

  // The lesson's tally counts from the moment the routine reached NO-WIN, not
  // from page load, so a visitor who arrives mid-crisis still sees it start at
  // nothing and climb.
  useEffect(() => {
    setLessonStart((previous) => (aborted ? previous ?? tick : null));
  }, [aborted, tick]);

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
            <CodeReadout locked={locked} aborted={aborted} />
          </div>
          <div style={{ flex: 1 }}>
            <LampBank rows={6} cols={10} epoch={epoch} density={density} bank={3} />
          </div>
        </div>
        {aborted ? (
          <SelfPlayBank tick={tick - (lessonStart ?? tick)} />
        ) : (
          <LampBank rows={3} cols={28} epoch={epoch} density={Math.max(8, density - 10)} bank={4} />
        )}
      </div>
    </CRTScreen>
  );
}
