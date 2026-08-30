# emulator/relay — the networks

**Tech:** TypeScript / Node over WebSocket · **Spec:** `docs/comms-protocol.md` in the
private engine repo ([`real-wopr`](https://github.com/DanielLandi/real-wopr); sibling
checkout: `../real-wopr/docs/comms-protocol.md`)

The *wire*, not application logic. Imposes era-accurate constraints — baud throttling
(token bucket), latency, framing, dial-up handshake FSM — on every link between the surfaces
and the bridge. Toggleable between `authentic` and `fast` modes. Kept as its own module on
purpose: it must be independently measured and switched.

## Layout

```
emulator/relay/
├── src/
│   ├── config.ts       # link profiles + COMMS_MODE toggle (env-overridable)
│   ├── envelope.ts     # §5 envelope codec, chunking, reassembly
│   ├── bucket.ts       # token-bucket baud throttle (§3.1)
│   ├── shaper.ts       # per-direction framing + baud + latency±jitter (§3)
│   ├── handshake.ts    # dial-up FSM incl. NO_CARRIER/BUSY (§4)
│   ├── server.ts       # WS proxy: /link (public) ⇄ node-host WS (internal)
│   ├── main.ts         # service entry (env-driven, deployment.md D6)
│   ├── registry.ts     # the frame room: which node answers which line, on which network
│   ├── network.ts      # one network, one relay process — built from a pack descriptor
│   ├── network-main.ts # run one network's relay (WOPR_NETWORK env)
│   ├── node-proto.ts   # NODE/1 — nodes register their lines outbound; calls ride back
│   ├── trunk.ts        # TRUNK/1 — the exchange-to-exchange switchboard hub
│   └── tieline.ts      # host side of TRUNK/1: one outbound trunk to a hub
├── tests/              # node:test — throughput, parity, toggle, FSM, federation, e2e
└── tools/              # dev-bridge-stub.ts (dev-only canned node host)
```

## Status

**Implemented.** Runs as its own container per deployment.md D1/D3: public WS at
`/link`, upstream to `ws://bridge:8000/ws/session/{id}` on the internal network with the
`x-wopr-internal-token` header. The bridge's WS path is never routed publicly, so this layer
cannot be bypassed. The same token goes on `openLocalLeg`'s `POST /api/session` — the bridge
mints the two TRUNK surfaces for the relay and for nobody else (#74) — taken from
`internalToken` on `ServerOpts`/`TielineOpts`, or from `BRIDGE_INTERNAL_TOKEN` in the
environment. A relay that sends no token places machine calls that all refuse with
`no session`.

```bash
npm install
npm test                 # throughput-at-baud, parity, toggle, FSM, federation, e2e
npm run dev              # service on :8081 (COMMS_MODE, BRIDGE_WS_URL, ...)
npm run dev:bridge-stub  # dev-only fake bridge on :8000 (use when the real bridge is not running)
```

Requires Node ≥ 23.6 (native type-stripping; scripts run `.ts` directly).
