// Message envelope (docs/comms-protocol.md §5). The shaper never inspects
// `payload`; it only times and frames it.

export type FrameKind = "input" | "output" | "control" | "handshake" | "prompt";

export interface Envelope {
  v: 1;
  session: string;
  seq: number;
  kind: FrameKind;
  link: string;
  payload: string;
  eom: boolean;
}

const KINDS: readonly FrameKind[] = ["input", "output", "control", "handshake", "prompt"];

export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}

export function decodeEnvelope(raw: string): Envelope {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("envelope: not JSON");
  }
  const e = obj as Partial<Envelope>;
  if (
    e === null || typeof e !== "object" ||
    e.v !== 1 ||
    typeof e.session !== "string" ||
    typeof e.seq !== "number" ||
    typeof e.kind !== "string" || !KINDS.includes(e.kind as FrameKind) ||
    typeof e.link !== "string" ||
    typeof e.payload !== "string" ||
    typeof e.eom !== "boolean"
  ) {
    throw new Error("envelope: malformed");
  }
  return e as Envelope;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Split a payload into fixed-width chunks of at most `frameBytes` UTF-8 bytes,
 * never splitting inside a code point (docs/comms-protocol.md §3.3).
 * An empty payload yields a single empty chunk so the frame still flows.
 */
export function chunkPayload(payload: string, frameBytes: number): string[] {
  if (payload.length === 0) return [""];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of payload) {
    const b = byteLength(ch);
    if (currentBytes + b > frameBytes && current.length > 0) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += b;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Reassemble ordered frames into complete messages: payloads concatenate until
 * a frame with eom=true closes the message. Used by the final consumer (bridge
 * or surface), never by the shaper itself.
 */
export function reassemble(frames: Envelope[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const f of frames) {
    current += f.payload;
    if (f.eom) {
      messages.push(current);
      current = "";
    }
  }
  return messages;
}
