// Link profiles — config, not code (docs/comms-protocol.md §2, §6).
// Values are env-overridable; the global toggle COMMS_MODE=authentic|fast selects
// between each surface's authentic profile and `off`.

export type CommsMode = "authentic" | "fast";
export type HandshakeKind = "dialup" | "carrier" | "none";

export interface LinkProfile {
  /** Simulated line rate, bits per second. 0 = uncapped. */
  baud: number;
  /** Wire bits per user-visible character (start/stop/parity framing). Default 10. */
  bits_per_char: number;
  /** One-way injected latency, ms. */
  latency_ms: number;
  /** Uniform jitter, ± ms. */
  jitter_ms: number;
  /** Fixed frame width in bytes for chunked emission. */
  frame_bytes: number;
  /** Connect-time ritual. */
  handshake: HandshakeKind;
}

export interface CommsConfig {
  mode: CommsMode;
  profiles: Record<string, LinkProfile>;
  surface_links: Record<string, string>;
}

export const DEFAULT_CONFIG: CommsConfig = {
  mode: "authentic",
  profiles: {
    "dialup-300": {
      baud: 300, bits_per_char: 10, latency_ms: 120, jitter_ms: 80,
      frame_bytes: 64, handshake: "dialup",
    },
    "dialup-600": {
      baud: 600, bits_per_char: 10, latency_ms: 120, jitter_ms: 70,
      frame_bytes: 64, handshake: "dialup",
    },
    "dialup-1200": {
      baud: 1200, bits_per_char: 10, latency_ms: 120, jitter_ms: 60,
      frame_bytes: 64, handshake: "dialup",
    },
    "leased-9600": {
      baud: 9600, bits_per_char: 10, latency_ms: 40, jitter_ms: 20,
      frame_bytes: 256, handshake: "carrier",
    },
    "internal-bus": {
      baud: 0, bits_per_char: 10, latency_ms: 5, jitter_ms: 0,
      frame_bytes: 256, handshake: "none",
    },
    off: {
      baud: 0, bits_per_char: 10, latency_ms: 0, jitter_ms: 0,
      frame_bytes: 64, handshake: "none",
    },
  },
  surface_links: {
    "home-terminal": "dialup-600",
    "norad-terminal": "leased-9600",
    "norad-bigboard": "internal-bus",
    "wopr-panel": "internal-bus",
    // A machine that ANSWERS a machine runs the same ritual a person's call
    // runs — 1200 baud is the period read of a business line between two
    // installations, faster than David's 600-baud home line and slower than
    // NORAD's leased circuit.
    "trunk-call": "dialup-1200",
    // A machine that PLACES a call must not shape: the answering end already
    // paces the call, and two shapers in series halve throughput and double
    // latency for no fiction. `off` is baud 0, handshake "none".
    "trunk-caller": "off",
  },
};

/** Resolve the profile a surface gets under the current mode (docs/comms-protocol.md §2). */
export function resolveLink(
  config: CommsConfig,
  surface: string,
): { name: string; profile: LinkProfile; authenticName: string } | undefined {
  const authenticName = config.surface_links[surface];
  if (!authenticName) return undefined;
  const name = config.mode === "fast" ? "off" : authenticName;
  const profile = config.profiles[name];
  if (!profile) return undefined;
  return { name, profile, authenticName };
}

/** Build config from the environment (COMMS_MODE, COMMS_BAUD, COMMS_LATENCY_MS, COMMS_JITTER_MS). */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): CommsConfig {
  const cfg: CommsConfig = structuredClone(DEFAULT_CONFIG);
  if (env.COMMS_MODE === "fast" || env.COMMS_MODE === "authentic") cfg.mode = env.COMMS_MODE;
  // Individual knobs override every authentic profile — for experimentation only.
  for (const key of ["baud", "latency_ms", "jitter_ms"] as const) {
    const envName = `COMMS_${key === "baud" ? "BAUD" : key.toUpperCase().replace("_MS", "_MS")}`;
    const raw = env[envName];
    if (raw !== undefined && raw !== "") {
      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0) {
        for (const name of Object.keys(cfg.profiles)) {
          if (name !== "off") cfg.profiles[name][key] = v;
        }
      }
    }
  }
  return cfg;
}
