"use client";
// NORAD screen wall — a room of monitors observing one war (issue #38;
// docs/superpowers/specs/2026-07-20-norad-screen-wall-design.md).
// Pure composition: each live monitor is an iframe of an exported sibling
// surface sharing the same ?room=. The wall renders no game state itself.

import { useEffect, useRef, useState } from "react";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  fitScale,
  monitors,
  monitorSrc,
  wallParamsFromSearch,
  type Monitor,
  type WallParams,
} from "./wall";

const MONITORS = monitors({
  bigboard: process.env.NEXT_PUBLIC_BIGBOARD_URL,
  panel: process.env.NEXT_PUBLIC_PANEL_URL,
  norad: process.env.NEXT_PUBLIC_NORAD_URL,
  tracks: process.env.NEXT_PUBLIC_TRACKS_URL,
});

function MonitorTile({
  monitor,
  src,
  focused,
  anyFocused,
  onFocus,
  onBack,
}: {
  monitor: Monitor;
  src: string | null;
  focused: boolean;
  anyFocused: boolean;
  onFocus: () => void;
  onBack: () => void;
}) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setScale(fitScale(r.width, r.height));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const offline = monitor.base === null;
  const cls = [
    "monitor",
    `monitor-${monitor.id}`,
    focused ? "focused" : "",
    anyFocused && !focused ? "dimmed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      <div className="monitor-title">
        <span>{monitor.title}</span>
        {focused && (
          <button type="button" className="back" onClick={onBack}>
            ◀ BACK TO WALL
          </button>
        )}
      </div>
      <div className={offline ? "screen offline" : "screen"} ref={screenRef}>
        {offline ? (
          <span className="offline-label">OFFLINE</span>
        ) : (
          src && (
            <iframe
              title={monitor.title}
              src={src}
              style={{
                width: DESIGN_WIDTH,
                height: DESIGN_HEIGHT,
                transform: `translate(-50%, -50%) scale(${scale})`,
              }}
            />
          )
        )}
        {!offline && !focused && (
          <button
            type="button"
            className="glass"
            aria-label={`FOCUS ${monitor.title}`}
            onClick={onFocus}
          />
        )}
      </div>
    </div>
  );
}

export default function Page() {
  const [params, setParams] = useState<WallParams | null>(null);
  const [focusedId, setFocusedId] = useState<Monitor["id"] | null>(null);

  // Resolve the shared room once, before any iframe mounts, so screens never
  // remount (and re-dial) with a late room code.
  useEffect(() => {
    const p = wallParamsFromSearch(window.location.search);
    if (p.room || p.malformedRoom) {
      setParams(p);
      return;
    }
    const apiBase = p.api ?? process.env.NEXT_PUBLIC_API_URL;
    if (!apiBase) {
      setParams(p);
      return;
    }
    let cancelled = false;
    (async () => {
      let next = p;
      try {
        const res = await fetch(`${apiBase}/api/room`, { method: "POST" });
        if (res.ok) {
          const code = (await res.json()).room_code as string;
          if (!cancelled) {
            const q = new URLSearchParams(window.location.search);
            q.set("room", code);
            history.replaceState(null, "", `${window.location.pathname}?${q}`);
            next = { ...p, room: code };
          }
        }
      } catch {
        // Roomless fallback: screens observe the global room.
      }
      if (!cancelled) setParams(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocusedId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className="room">
      <header className="room-header">
        <span className="room-title">NORAD // SCREEN WALL</span>
        <span className="room-status">
          {params === null
            ? "ESTABLISHING CONFERENCE..."
            : params.malformedRoom
              ? `MALFORMED ROOM CODE: ${params.malformedRoom}`
              : params.room
                ? `CONFERENCE: ${params.room}`
                : "NO CONFERENCE — OBSERVING GLOBAL ROOM"}
        </span>
      </header>
      <div className="wall">
        {MONITORS.map((m) => (
          <MonitorTile
            key={m.id}
            monitor={m}
            src={
              m.base && params !== null
                ? monitorSrc(m.base, {
                    room: params.room,
                    api: params.api,
                    link: params.link,
                  })
                : null
            }
            focused={focusedId === m.id}
            anyFocused={focusedId !== null}
            onFocus={() => setFocusedId(m.id)}
            onBack={() => setFocusedId(null)}
          />
        ))}
      </div>
      {focusedId !== null && (
        <div className="backdrop" onClick={() => setFocusedId(null)} />
      )}
    </main>
  );
}
