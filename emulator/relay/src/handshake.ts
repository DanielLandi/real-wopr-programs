// Connect-time dial-up FSM (docs/comms-protocol.md §4). Theatrical AND
// functional: the surface renders each transition, and no application frames
// flow until CONNECTED. Failure states are reachable on purpose.

import type { CommsMode, HandshakeKind } from "./config.ts";

export type HandshakeState =
  | "IDLE"
  | "DIALING"
  | "RINGING"
  | "CARRIER_DETECT"
  | "HANDSHAKE"
  | "CONNECTED"
  | "NO_CARRIER"
  | "BUSY";

export interface HandshakeOpts {
  /** Multiply all durations (tests use ~0.01). */
  timeScale?: number;
  rng?: () => number;
  /** Probability [0,1] that the dial attempt fails with NO_CARRIER/BUSY. */
  failRate?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run the connect ritual, emitting each transition. Resolves true when
 * CONNECTED, false on a failure state. In `fast` mode the FSM collapses to an
 * instant CONNECTED (§4); `none` links emit nothing at all.
 */
export async function runHandshake(
  kind: HandshakeKind,
  mode: CommsMode,
  baud: number,
  emit: (state: HandshakeState, detail: string) => void,
  opts: HandshakeOpts = {},
): Promise<boolean> {
  const scale = opts.timeScale ?? 1;
  const rng = opts.rng ?? Math.random;
  const failRate = opts.failRate ?? 0;
  const banner = `CONNECT ${baud > 0 ? baud : "FAST"}`;

  if (kind === "none") return true;

  if (mode === "fast") {
    emit("CONNECTED", banner);
    return true;
  }

  if (kind === "carrier") {
    // Leased lines fail too (COMMS_FAIL_RATE covers resync as well as dial):
    // the surface needs a NO_CARRIER frame to retry from, not a silent hang.
    if (rng() < failRate) {
      await sleep(500 * scale);
      emit("NO_CARRIER", "NO CARRIER");
      return false;
    }
    emit("CARRIER_DETECT", "CARRIER DETECTED");
    await sleep(500 * scale);
    emit("CONNECTED", banner);
    return true;
  }

  // Full dial-up ritual.
  emit("DIALING", "DIALING...");
  await sleep(2000 * scale);
  emit("RINGING", "RINGING");
  await sleep((1000 + rng() * 3000) * scale);
  if (rng() < failRate) {
    if (rng() < 0.5) {
      emit("BUSY", "BUSY");
    } else {
      emit("NO_CARRIER", "NO CARRIER");
    }
    return false;
  }
  emit("CARRIER_DETECT", "CARRIER DETECTED");
  await sleep(1000 * scale);
  emit("HANDSHAKE", "HANDSHAKE");
  await sleep(2000 * scale);
  emit("CONNECTED", banner);
  return true;
}
