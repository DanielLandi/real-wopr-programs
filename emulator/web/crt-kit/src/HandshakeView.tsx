"use client";
// <HandshakeView> — renders the dial-up FSM transitions as they arrive from
// the link (docs/comms-protocol.md §4), with modem audio per state.

import { useEffect, useRef } from "react";
import { ModemAudio } from "./audio";

export interface HandshakeViewProps {
  /** Handshake frame payloads received so far, e.g. "DIALING DIALING...". */
  states: string[];
  audio?: boolean;
}

const LABELS: Record<string, string> = {
  DIALING: "DIALING...",
  RINGING: "RINGING",
  CARRIER_DETECT: "CARRIER DETECTED",
  HANDSHAKE: "░▒▓ HANDSHAKE ▓▒░",
  NO_CARRIER: "NO CARRIER",
  BUSY: "BUSY",
};

export function HandshakeView({ states, audio = true }: HandshakeViewProps) {
  const modem = useRef<ModemAudio | null>(null);
  const played = useRef(0);

  useEffect(() => {
    if (!audio) return;
    if (!modem.current) modem.current = new ModemAudio();
    for (; played.current < states.length; played.current++) {
      modem.current.play(states[played.current]);
    }
  }, [states, audio]);

  useEffect(() => () => modem.current?.close(), []);

  return (
    <div>
      {states.map((s, i) => {
        const state = s.split(" ")[0];
        const isConnect = state === "CONNECTED";
        const banner = isConnect ? s.slice(s.indexOf(" ") + 1) : LABELS[state] ?? s;
        return (
          <div key={i} style={{ letterSpacing: "0.05em" }}>
            {isConnect ? `\n${banner}\n` : banner}
          </div>
        );
      })}
    </div>
  );
}
