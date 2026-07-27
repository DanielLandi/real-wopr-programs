// The relay — public surface.
// Spec: the engine repo's comms-protocol.md · Topology: its deployment.md D1/D3.

export {
  DEFAULT_CONFIG,
  configFromEnv,
  resolveLink,
  type CommsMode,
  type CommsConfig,
  type LinkProfile,
  type HandshakeKind,
} from "./config.ts";
export {
  encodeEnvelope,
  decodeEnvelope,
  chunkPayload,
  reassemble,
  byteLength,
  type Envelope,
  type FrameKind,
} from "./envelope.ts";
export { TokenBucket } from "./bucket.ts";
export { LinkShaper, type OutboundMessage, type ShaperOpts } from "./shaper.ts";
export { runHandshake, type HandshakeState, type HandshakeOpts } from "./handshake.ts";
export { startServer, type ServerOpts, type RunningServer } from "./server.ts";
