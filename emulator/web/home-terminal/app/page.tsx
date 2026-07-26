"use client";
// Home Terminal — David Lightman's bedroom (docs/surfaces.md §1).
// Single full-screen CRT, green phosphor, no chrome, KEYBOARD ONLY: an
// IMSAI 8080 has no mouse. Everything is driven from the command line — a
// local interpreter (app/console.ts) handles the pre-connect grammar (DIAL,
// ATDT, DIRECTORY, SCAN, WARDIAL, ...), and once a carrier is up the same
// line passes straight through to the exchange. Output renders at link speed:
// the comms layer's dialup-300 profile owns the cadence, this page only
// appends what arrives.
//
// Phone-book mode: if an exchange directory (phonebook.json) is served next
// to this export, the terminal lists community-run exchanges and can war-dial
// them. Without a directory it dials the same-origin/default exchange (D3).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CRTScreen,
  Teletype,
  CommandLine,
  JoshuaVoice,
  ModemAudio,
  WoprLink,
  type LinkEvent,
} from "@real-wopr/crt-kit";
import { loadExchanges, probe, type Exchange } from "./exchanges";
import { isSystem, DIAL_SYSTEMS } from "./sims";
import { buildSweep, type SweepEntry } from "./wardial";
import { parse, initialText, sessionBody, type DialTarget, type ConsoleContext } from "./console";

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

type Phase = "idle" | "scanning" | "dialing" | "connected" | "no-carrier";

const BOOT_TEXT = `IMSAI 8080  SELF TEST OK
64K RAM     CP/M 2.2
MODEM: BELL 103 COMPATIBLE  300 BAUD

READY.
`;

/** The dial-up FSM states as displayed teletype lines (docs/comms-protocol.md
 *  §4). Surface-local copy of the labels the crt-kit HandshakeView renders —
 *  here the sequence is folded into the single scrollback so it interleaves
 *  correctly with command echoes and session output. */
const HANDSHAKE_LABELS: Record<string, string> = {
  DIALING: "DIALING...",
  RINGING: "RINGING",
  CARRIER_DETECT: "CARRIER DETECTED",
  HANDSHAKE: "░▒▓ HANDSHAKE ▓▒░",
  NO_CARRIER: "NO CARRIER",
  BUSY: "BUSY",
};

export default function HomeTerminal() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState(">");
  const [exchanges, setExchanges] = useState<Exchange[] | null>(null);
  const [hits, setHits] = useState<SweepEntry[] | null>(null);
  const [voiceOn, setVoiceOn] = useState(false);
  const link = useRef<WoprLink | null>(null);
  // Unsubscribe for the current link's event listener. Detaching before a
  // deliberate hangup keeps that self-inflicted close from printing NO CARRIER.
  const detach = useRef<(() => void) | null>(null);
  const active = useRef<DialTarget | null>(null);
  // Mirror of `phase` for the event handlers, which run outside render and must
  // read the live phase synchronously (issue #88 close defense).
  const phaseRef = useRef<Phase>("idle");
  // Set when a control NO CARRIER frame has already been printed for this drop,
  // so the WS close that follows it does not print a second NO CARRIER.
  const sawNoCarrierFrame = useRef(false);
  const handshakeBuf = useRef("");
  const promptBuf = useRef("");
  const sweepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modem = useRef<ModemAudio | null>(null);
  // S10 — the machine speaks: completed output lines are fed to Web Speech
  // when VOICE is ON (crt-kit JoshuaVoice, fidelity-notes.md §5).
  const voice = useRef<JoshuaVoice | null>(null);
  const voiceLine = useRef("");
  const booted = useRef(false);
  // Set on unmount so an in-flight session mint / retry abandons silently
  // instead of touching state on a torn-down component.
  const disposed = useRef(false);

  /** Append a complete, newline-terminated chunk to the scrollback, starting
   *  it on a fresh line. Used for command echoes, the handshake FSM, and the
   *  scan/war-dial montage — never for raw streamed link output. */
  const appendText = useCallback((s: string) => {
    setText((t) => `${t}${t === "" || t.endsWith("\n") ? "" : "\n"}${s}`);
  }, []);

  useEffect(() => {
    void loadExchanges().then((list) => {
      setExchanges(list);
      if (booted.current) return;
      booted.current = true;
      // First paint: the IMSAI banner, the directory, and the HELP hint —
      // everything the old buttons used to convey, now as plain text.
      setText(BOOT_TEXT + initialText({ exchanges: list, systems: DIAL_SYSTEMS, hits: null }));
    });
  }, []);

  // Keep phaseRef in step with phase for the out-of-render link handlers.
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  const onLinkEvent = useCallback((e: LinkEvent) => {
    if (e.type === "close") {
      // An unexpected carrier loss mid-session must announce itself on the line;
      // the old handler flipped phase silently and left a dead prompt (#88).
      // Skip the print when the comms layer already delivered a control NO
      // CARRIER for this drop (sawNoCarrierFrame), and when the close is our own
      // deliberate hangup (the link is detached first, so this never fires).
      const unexpected = phaseRef.current === "connected" || phaseRef.current === "dialing";
      if (unexpected && !sawNoCarrierFrame.current) {
        setText((t) => `${t}\n\nNO CARRIER\n`);
      }
      sawNoCarrierFrame.current = false;
      setPhase((p) => (p === "connected" || p === "dialing" ? "no-carrier" : p));
      return;
    }
    if (e.type !== "frame") return;
    const f = e.frame;
    if (f.kind === "handshake") {
      // Handshake payloads may arrive chunked; reassemble per message.
      handshakeBuf.current += f.payload;
      if (!f.eom) return;
      const msg = handshakeBuf.current;
      handshakeBuf.current = "";
      const state = msg.split(" ")[0];
      if (!modem.current) modem.current = new ModemAudio();
      modem.current.play(state);
      if (state === "CONNECTED") {
        appendText(`\n${msg.slice(msg.indexOf(" ") + 1)}\n`);
        setPhase("connected");
      } else {
        appendText(`${HANDSHAKE_LABELS[state] ?? state}\n`);
        if (state === "NO_CARRIER" || state === "BUSY") setPhase("no-carrier");
      }
      return;
    }
    if (f.kind === "prompt") {
      // The mode indicator lives on the input line, not in the transcript.
      // Reassemble first: output frames survive chunking because they append,
      // but a prompt REPLACES, so at dialup-300's two-byte quantum "[TTT]>"
      // would land as "]>" — the last quantum only.
      promptBuf.current += f.payload;
      if (!f.eom) return;
      const p = promptBuf.current;
      promptBuf.current = "";
      setPrompt(p || ">");
      return;
    }
    if (f.kind === "output") {
      // Raw append — payloads stream mid-line, so no fresh-line guard here.
      setText((t) => t + f.payload);
      voiceLine.current += f.payload;
      const lines = voiceLine.current.split("\n");
      voiceLine.current = lines.pop() ?? "";
      for (const l of lines) voice.current?.speak(l);
      return;
    }
    if (f.kind === "control" && f.payload === "NO CARRIER") {
      // Mark it so the WS close that the comms layer sends right after this
      // frame does not print a duplicate NO CARRIER (#88).
      sawNoCarrierFrame.current = true;
      setText((t) => `${t}\n\nNO CARRIER\n`);
      setPhase("no-carrier");
    }
  }, [appendText]);

  // Mint a session token, absorbing one transient failure. During an exchange
  // redeploy the tunnel 502s for a few seconds; without this a dial that lands
  // in that window prints ...UNREACHABLE instantly. So on a failed mint (bad
  // status or a thrown fetch) we announce LINE BUSY - RETRYING and try once
  // more after a short wait. Returns the session, or null when it should be
  // abandoned — both attempts failed, OR a newer dial superseded us / we
  // unmounted while waiting (the caller distinguishes these via the same
  // still-ours guard, staying silent on supersession). The two call sites POST
  // different bodies, so the body is parameterised. (#93)
  const mintSession = useCallback(
    async (
      apiBase: string,
      body: Record<string, unknown>,
      target: DialTarget | null,
    ): Promise<{ session_id: string; token: string } | null> => {
      const stillOurs = () => !disposed.current && active.current?.id === target?.id;
      const once = async () => {
        const res = await fetch(`${apiBase}/api/session`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(String(res.status));
        return (await res.json()) as { session_id: string; token: string };
      };
      try {
        return await once();
      } catch (err) {
        // A 4xx is deterministic (unknown system, malformed request) — retrying
        // only stalls the terminal, so fail fast. Reserve the one retry for a
        // transient failure (a 5xx or a network/tunnel error, e.g. the brief
        // 502 window while an exchange redeploys).
        const status = Number((err as Error)?.message);
        const permanent = status >= 400 && status < 500;
        if (permanent || !stillOurs()) return null;
        appendText("LINE BUSY - RETRYING\n");
        await new Promise((r) => setTimeout(r, 2500));
        if (!stillOurs()) return null;
        try {
          return await once();
        } catch {
          return null;
        }
      }
    },
    [appendText],
  );

  const dial = useCallback((target: DialTarget | null) => {
    const room = roomCodeFromLocation();
    if (room.malformed !== undefined) {
      // Refuse to dial with a bad ?room= — connecting roomless would silently
      // strand the caller outside the room they asked for.
      appendText(
        `INVALID ROOM CODE "${room.malformed}"\n` +
          `ROOM CODES ARE 6 CHARACTERS FROM ${ROOM_ALPHABET}\n` +
          "CORRECT THE ?room= PARAMETER AND REDIAL\n",
      );
      setPhase("no-carrier");
      return;
    }
    setPhase("dialing");
    // A fresh dial clears any pending carrier-loss notice from a prior line.
    sawNoCarrierFrame.current = false;
    voiceLine.current = "";
    voice.current?.cancel();
    appendText(`\nDIALING ${target ? target.name : "UNKNOWN"}\n`);
    if (link.current && active.current?.id === target?.id) {
      link.current.sendControl("DIAL"); // retry on the same line
      return;
    }
    // Detach before hanging up the old line: this close is deliberate and must
    // not print NO CARRIER (#88).
    detach.current?.();
    detach.current = null;
    link.current?.hangup();
    link.current = null;
    active.current = target;
    // When the export is mis-built without NEXT_PUBLIC_API_URL, degrade to the
    // phone book's first exchange instead of POSTing same-origin (405).
    const fallback = exchanges && exchanges.length > 0 ? exchanges[0] : null;
    if (isSystem(target)) {
      // A real remote system on the default bridge (SYSTEM/1) — same path as WOPR.
      void (async () => {
        const apiBase = process.env.NEXT_PUBLIC_API_URL || fallback?.api || "";
        const s = await mintSession(
          apiBase,
          sessionBody("home-terminal", room.code, target.systemId),
          target,
        );
        if (!s) {
          // A newer dial / unmount abandons silently; a real failure speaks.
          if (!disposed.current && active.current?.id === target?.id) {
            appendText("SYSTEM UNREACHABLE\n");
            setPhase("no-carrier");
          }
          return;
        }
        if (disposed.current || active.current?.id !== target?.id) return;
        link.current = new WoprLink({
          url: process.env.NEXT_PUBLIC_COMMS_URL || fallback?.link,
          surface: "home-terminal",
          session: s.session_id,
          token: s.token,
        });
        detach.current = link.current.onEvent(onLinkEvent);
        link.current.connect();
      })();
      return;
    }
    const exchange = target;
    void (async () => {
      // The bridge issues the session + HMAC token (api-contract.md §2, D4).
      const apiBase = exchange?.api ?? process.env.NEXT_PUBLIC_API_URL ?? "";
      const s = await mintSession(
        apiBase,
        sessionBody("home-terminal", room.code, null),
        target,
      );
      if (!s) {
        if (!disposed.current && active.current?.id === target?.id) {
          appendText("EXCHANGE UNREACHABLE\n");
          setPhase("no-carrier");
        }
        return;
      }
      if (disposed.current || active.current?.id !== target?.id) return;
      link.current = new WoprLink({
        url: exchange?.link ?? process.env.NEXT_PUBLIC_COMMS_URL, // default: same-origin /link (D3)
        surface: "home-terminal",
        session: s.session_id,
        token: s.token,
      });
      detach.current = link.current.onEvent(onLinkEvent);
      link.current.connect();
    })();
  }, [onLinkEvent, exchanges, appendText, mintSession]);

  // The war-dialer: probe each registered exchange in order, connect to the
  // first carrier. Output here is local to the "modem", not link-shaped.
  const doScan = useCallback(() => {
    if (!exchanges || exchanges.length === 0) {
      appendText("NO EXCHANGES REGISTERED - NOTHING TO SCAN.\n");
      return;
    }
    setPhase("scanning");
    appendText("\nSCANNING FOR CARRIERS...\n\n");
    void (async () => {
      for (const e of exchanges) {
        const up = await probe(e);
        appendText(`ATDT ${e.name} [${e.region}] ... ${up ? "CARRIER DETECTED" : "NO CARRIER"}\n`);
        if (up) {
          dial(e);
          return;
        }
      }
      appendText("\nSCAN COMPLETE. NO CARRIERS AVAILABLE.\n");
      setPhase("no-carrier");
    })();
  }, [exchanges, dial, appendText]);

  // The war-dial montage: replay David's auto-dialer sweep at period cadence,
  // then leave a reviewable numbered hit list (DIAL <n> connects to one).
  const warDial = useCallback(() => {
    const sweep = buildSweep(DIAL_SYSTEMS);
    setHits(null);
    setPhase("scanning");
    appendText("\nWAR-DIALING SUNNYVALE PREFIX...\n\n");
    let i = 0;
    const step = () => {
      if (i >= sweep.length) {
        const carriers = sweep.filter((e) => e.status === "CARRIER");
        appendText(`\nSCAN COMPLETE - ${carriers.length} CARRIERS FOUND\n`);
        carriers.forEach((e, idx) => {
          const label = e.hit?.target ? e.hit.target.name : "??? UNKNOWN SYSTEM";
          appendText(`${String(idx + 1).padStart(2, "0")}  ${e.number}  ${label}  [${e.hit?.label}]\n`);
        });
        appendText("\nDIAL <NN> TO CONNECT TO A CARRIER\n");
        setHits(carriers);
        setPhase("idle");
        sweepTimer.current = null;
        return;
      }
      const e = sweep[i++];
      const tail = e.status === "CARRIER" ? `CARRIER  [${e.hit?.label}]` : e.status;
      appendText(`ATDT ${e.number} ... RINGING ... ${tail}\n`);
      sweepTimer.current = setTimeout(step, 450);
    };
    sweepTimer.current = setTimeout(step, 450);
  }, [appendText]);

  useEffect(() => () => {
    disposed.current = true;
    detach.current?.();
    detach.current = null;
    link.current?.hangup();
    voice.current?.cancel();
    modem.current?.close();
    if (sweepTimer.current) clearTimeout(sweepTimer.current);
  }, []);

  // The Enter keypress is the user gesture speech synthesis needs — create the
  // JoshuaVoice lazily on the first VOICE command.
  const applyVoice = (on: boolean) => {
    if (!voice.current) voice.current = new JoshuaVoice();
    voice.current.enabled = on;
    if (!on) voice.current.cancel();
    setVoiceOn(on);
    appendText(`VOICE ${on ? "ON" : "OFF"}\n`);
  };

  const runLocalCommand = (line: string) => {
    const trimmed = line.trim();
    const echo = trimmed === "" ? "" : `> ${trimmed.toUpperCase()}\n`;
    const ctx: ConsoleContext = { exchanges, systems: DIAL_SYSTEMS, hits };
    const action = parse(line, ctx);
    switch (action.kind) {
      case "help":
      case "print":
      case "error":
        appendText(echo + action.text);
        return;
      case "directory":
        // A fresh DIRECTORY clears any pending war-dial hit list, so DIAL <n>
        // resolves against the book again.
        setHits(null);
        appendText(echo + action.text);
        return;
      case "dial":
        appendText(echo);
        dial(action.target);
        return;
      case "scan":
        appendText(echo);
        doScan();
        return;
      case "wardial":
        appendText(echo);
        warDial();
        return;
      case "redial":
        appendText(echo);
        dial(active.current);
        return;
      case "voice":
        appendText(echo);
        applyVoice(action.on);
        return;
    }
  };

  const submit = (line: string) => {
    // Once a carrier is up the line passes straight through to the exchange;
    // otherwise the local interpreter owns it.
    if (phase === "connected" && link.current) {
      const cmd = line.toUpperCase();
      appendText(`> ${cmd}`);
      link.current.sendInput(cmd);
      return;
    }
    runLocalCommand(line);
  };

  return (
    <CRTScreen theme="green" columns={80}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "0.8rem",
          left: "1rem",
          color: "var(--crt-dim)",
          letterSpacing: "0.05em",
          pointerEvents: "none",
        }}
      >
        IMSAI 8080
      </div>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "0.8rem",
          right: "1rem",
          color: "var(--crt-dim)",
          letterSpacing: "0.05em",
          pointerEvents: "none",
          opacity: voiceOn ? 1 : 0.6,
        }}
      >
        VOICE {voiceOn ? "ON" : "OFF"}
      </div>
      {/* The CommandLine owns the one cursor (on the > prompt line) in every
          phase; the Teletype never blinks a second one. */}
      <Teletype text={text} cursor={false} />
      <CommandLine prompt={prompt} onSubmit={submit} onBreak={() => link.current?.sendControl("BREAK")} />
    </CRTScreen>
  );
}
