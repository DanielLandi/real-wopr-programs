# Module 2 — Comms Simulation Layer

**Tech:** TypeScript / Node over WebSocket · **Spec:** [`../docs/comms-protocol.md`](../docs/comms-protocol.md)

The *wire*, not application logic. Imposes era-accurate constraints — baud throttling
(token bucket), latency, framing, dial-up handshake FSM — on every link between the surfaces
and the bridge. Toggleable between `authentic` and `fast` modes. Kept as its own module on
purpose: it must be independently measured and switched.

## Layout

```
comms-layer/
├── src/
│   ├── config.ts     # link profiles + COMMS_MODE toggle (env-overridable)
│   ├── envelope.ts   # §5 envelope codec, chunking, reassembly
│   ├── bucket.ts     # token-bucket baud throttle (§3.1)
│   ├── shaper.ts     # per-direction framing + baud + latency±jitter (§3)
│   ├── handshake.ts  # dial-up FSM incl. NO_CARRIER/BUSY (§4)
│   ├── server.ts     # WS proxy: /link (public) ⇄ bridge WS (internal)
│   └── main.ts       # service entry (env-driven, deployment.md D6)
├── tests/            # node:test — throughput, parity, toggle, FSM, e2e proxy
└── tools/            # dev-bridge-stub.ts (dev-only canned bridge)
```

## Status

**Implemented.** Runs as its own container per deployment.md D1/D3: public WS at
`/link`, upstream to `ws://bridge:8000/ws/session/{id}` on the internal network with the
`x-wopr-internal-token` header. The bridge's WS path is never routed publicly, so this layer
cannot be bypassed.

```bash
npm install
npm test                 # 10 tests: throughput-at-baud, parity, toggle, FSM, e2e
npm run dev              # service on :8081 (COMMS_MODE, BRIDGE_WS_URL, ...)
npm run dev:bridge-stub  # dev-only fake bridge on :8000 (use when the real bridge is not running)
```

Requires Node ≥ 23.6 (native type-stripping; scripts run `.ts` directly).
