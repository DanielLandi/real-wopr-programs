"use client";
// NORAD Terminal — operator console inside NORAD (docs/surfaces.md §2).
// Amber phosphor, persistent status header, leased-9600 (carrier handshake
// only — no dial ritual). Command grammar is a constrained superset of the
// home terminal's; everything still goes through the bridge router.
//
// Screen and keyboard are the shared xterm terminal, and the arriving frames
// are the shared handler beside it (#108 §4). The retry policy stays split
// exactly where it was: the handler decides (budgets, what to announce), this
// page schedules (the 750 ms timers, the session poll) — the shared code owns
// no timers.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  StatusPanel,
  WoprLink,
  endpointFromQuery,
  type LinkEvent,
} from "@real-wopr/crt-kit";
// By path, not through the barrel: the barrel is shared with the feed surfaces,
// which must not pull xterm in behind it.
import { TerminalScreen, type XtermMount } from "@real-wopr/crt-kit/src/TerminalScreen";
import { awaitingAccessCode, clearanceFromText, wallUrl } from "./logon";
import { NoradFrameHandler, type NoradPhase as Phase } from "@real-wopr/terminal/frames";

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

/** Append starting on a fresh line — the rule the transcript has always used,
 *  and the one the shared renderer's appendText applies, so the mirror below
 *  and the screen stay identical. */
function onFreshLine(t: string, s: string): string {
  return `${t}${t.endsWith("\n") || t === "" ? "" : "\n"}${s}`;
}

export default function NoradTerminal() {
  const [phase, setPhase] = useState<Phase>("connecting");
  // A mirror of the transcript, not the thing on screen. The console reads its
  // own scrollback to know two things the wire never states outright: whether
  // the machine is waiting for an access code (mask the echo) and which
  // clearance was last accepted (the CLR readout). Both are contract strings
  // (api-contract.md §4), so the text has to be kept even though xterm draws it.
  const [text, setText] = useState("");
  const [defcon, setDefcon] = useState(5);
  const link = useRef<WoprLink | null>(null);
  const sessionRef = useRef<string>("");
  const tokenRef = useRef<string>("");
  const disposed = useRef(false);
  const recoveries = useRef(0);
  const pollStopped = useRef(false);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectLinkRef = useRef<() => void>(() => undefined);

  // The screen. xterm exists only in the browser, so during the static
  // export's prerender — and between first paint and the terminal loading —
  // there is nothing to write to; anything written then waits here and lands
  // in order once there is.
  const screen = useRef<XtermMount | null>(null);
  const pending = useRef<Array<(m: XtermMount) => void>>([]);
  const write = useCallback((fn: (m: XtermMount) => void) => {
    if (screen.current) fn(screen.current);
    else pending.current.push(fn);
  }, []);
  const onScreen = useCallback((m: XtermMount | null) => {
    screen.current = m;
    if (!m) return;
    const queued = pending.current;
    pending.current = [];
    for (const fn of queued) fn(m);
  }, []);

  const appendLine = useCallback(
    (s: string) => {
      setText((t) => onFreshLine(t, s));
      write((m) => m.sinks.appendText(s));
    },
    [write],
  );

  // The DOM-free frame-handling core (@real-wopr/terminal) — it owns the
  // reassembly buffers and the WS-close retry budget; this page only wires
  // its sinks onto the screen, React state, the refs, and the retry timers.
  // Built once: every sink closes over stable setters and refs.
  const frames = useRef<NoradFrameHandler | null>(null);
  if (frames.current === null) {
    frames.current = new NoradFrameHandler({
      isDisposed: () => disposed.current,
      setPhase,
      appendLine,
      appendRaw: (s) => {
        setText((t) => t + s);
        write((m) => m.sinks.appendRaw(s));
      },
      setPrompt: (p) => write((m) => m.setPrompt(p)),
      scheduleReconnect: () => {
        reconnectTimer.current = setTimeout(() => connectLinkRef.current(), 750);
      },
      scheduleRedial: () => {
        reconnectTimer.current = setTimeout(() => link.current?.sendControl("DIAL"), 750);
      },
      resetRecoveries: () => {
        recoveries.current = 0;
      },
    });
  }

  /** Mint a fresh bridge session for this console. Shared by first mount and
   *  by 404-recovery after a bridge restart wipes the in-memory session store.
   *  Preserves the malformed-?room= guard (report on-page, go DOWN) and the
   *  endpointFromQuery/env apiBase resolution. Returns true only when
   *  sessionRef/tokenRef were populated and the console is still live. */
  const mintSession = useCallback(async (): Promise<boolean> => {
    if (disposed.current) return false;
    const apiBase = endpointFromQuery("api", process.env.NEXT_PUBLIC_API_URL) ?? "";
    const room = roomCodeFromLocation();
    if (room.malformed !== undefined) {
      // Refuse to sync with a bad ?room= — connecting roomless would
      // silently strand the console outside the room it asked for.
      appendLine(
        `INVALID ROOM CODE "${room.malformed}"\n` +
          `ROOM CODES ARE 6 CHARACTERS FROM ${ROOM_ALPHABET}\n` +
          "CORRECT THE ?room= PARAMETER AND RELOAD CONSOLE\n",
      );
      setPhase("down");
      return false;
    }
    const res = await fetch(`${apiBase}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: "norad-terminal", room_code: room.code }),
    });
    if (!res.ok || disposed.current) return false;
    const s = (await res.json()) as { session_id: string; token: string };
    sessionRef.current = s.session_id;
    tokenRef.current = s.token;
    return true;
  }, [appendLine]);

  const onLinkEvent = useCallback((e: LinkEvent) => {
    frames.current?.onEvent(e);
  }, []);

  const connectLink = useCallback(() => {
    if (!sessionRef.current || !tokenRef.current || disposed.current) return;
    link.current?.hangup();
    // A fresh link must not inherit a prompt or handshake fragment stranded
    // by a drop on the old one — the buffers live in the frame handler.
    frames.current?.resetLink();
    const l = new WoprLink({
      url: endpointFromQuery("link", process.env.NEXT_PUBLIC_COMMS_URL),
      surface: "norad-terminal",
      session: sessionRef.current,
      token: tokenRef.current,
    });
    l.onEvent(onLinkEvent);
    l.connect();
    link.current = l;
  }, [onLinkEvent]);

  useEffect(() => {
    connectLinkRef.current = connectLink;
  }, [connectLink]);

  useEffect(() => {
    let cancelled = false;
    disposed.current = false;
    pollStopped.current = false;
    recoveries.current = 0;
    const apiBase = endpointFromQuery("api", process.env.NEXT_PUBLIC_API_URL) ?? "";
    (async () => {
      if (await mintSession()) {
        if (cancelled) return;
        connectLink();
      }
    })();

    // DEFCON readout: poll the session (bridge-relayed realtime lands with GTW).
    const poll = setInterval(async () => {
      // Once we've given up (recovery cap hit) stop touching the bridge — a
      // stale tab must never spam prod with polls against a dead session id.
      if (pollStopped.current || disposed.current || !sessionRef.current) return;
      try {
        const r = await fetch(`${apiBase}/api/session/${sessionRef.current}`);
        if (r.ok) {
          setDefcon(((await r.json()) as { defcon: number }).defcon);
        } else if (r.status === 404) {
          // Session gone: a bridge restart wiped the in-memory store. Self-heal
          // by re-minting rather than polling a dead id forever. This is also
          // the second line of defense after the WS-close retries exhaust
          // against the (now-vanished) session.
          if (recoveries.current < 3) {
            recoveries.current += 1;
            setPhase("reconnecting");
            appendLine("SESSION LOST - REDIALING\n");
            if (await mintSession()) connectLink();
          } else {
            appendLine("LINK DOWN - RELOAD CONSOLE\n");
            setPhase("down");
            pollStopped.current = true;
          }
        }
      } catch {
        /* header keeps last known value */
      }
    }, 10_000);

    return () => {
      cancelled = true;
      disposed.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      clearInterval(poll);
      link.current?.hangup();
    };
  }, [connectLink, mintSession, appendLine]);

  const masked = awaitingAccessCode(text);

  const submit = (line: string) => {
    const cmd = line.toUpperCase();
    if (!masked && cmd === "WALL") {
      const base =
        process.env.NEXT_PUBLIC_WALL_URL ?? `${window.location.origin}/warroom/`;
      const url = wallUrl(base, roomCodeFromLocation().code);
      appendLine(`WOPR> WALL\nSCREEN WALL: ${url}\n`);
      return;
    }
    // Never echo an access code — the prompt line stays bare.
    appendLine(`WOPR> ${masked ? "" : cmd}\n`);
    link.current?.sendInput(cmd);
  };

  // The terminal keeps its keystroke handler for the life of the page, so it
  // reads the submit closure through a ref rather than capturing the render it
  // was created in — otherwise an access code typed after the prompt arrives
  // would still be judged against a transcript that had not seen it.
  const submitRef = useRef(submit);
  submitRef.current = submit;

  const clearance = clearanceFromText(text);

  return (
    <TerminalScreen
      theme="amber"
      flicker={false}
      prompt="WOPR>"
      uppercase
      // No command line until the leased line is up — the console used to
      // render one only when connected, and this is the same rule.
      enabled={phase === "connected"}
      mask={masked}
      onLine={(line) => submitRef.current(line)}
      onBreak={() => link.current?.sendControl("BREAK")}
      onMount={onScreen}
    >
      <StatusPanel
        items={[
          { label: "CLR", value: clearance ? `${clearance.callsign} L${clearance.level}` : "----" },
          { label: "DEFCON", value: String(defcon) },
          {
            label: "LINK",
            value:
              phase === "connected"
                ? "9600 OK"
                : phase === "down"
                  ? "DOWN"
                  : phase === "reconnecting"
                    ? "RESYNC"
                    : "SYNC",
          },
        ]}
      />
      {phase === "down" && <div>LINK DOWN — RELOAD CONSOLE</div>}
    </TerminalScreen>
  );
}
