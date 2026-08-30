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
│                       #   (hosted inside server.ts when TRUNK_HUB_URL is set)
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

A `/link` dial also asks the bridge which surface the session actually is
(`GET /api/session/{id}`) before it resolves a pacing profile, because the `?surface=`
in the query string is the caller's claim and pacing is not theirs to choose (#80). A
claim that is not the session's surface closes the line `4403 surface does not match
session`; a session the bridge does not know closes `4404`, and a bridge that cannot be
asked closes `4503` — the lookup fails closed. So the relay needs the bridge's REST face
as well as its WS face, both at `BRIDGE_WS_URL`'s host.

## Close codes

The relay refuses with WebSocket close codes in the private `44xx`/`45xx` range, and the far
end decides from the code alone what to do next. Two sets: the *visitor* side (`/link`,
`/seat`, `/x/<code>/link` — `4400`, `4403`, `4404`, `4408`, `4429`, `4503`, described above
and in `server.ts`), and the *switchboard* side below — what the hub's `/trunk` says to a tie
line it will not have. A third-party peer reads this table, not the engine repo's, so it lives
next to the code it describes; `tests/trunk-close-codes.test.ts` greps the constants out of
`server.ts` and `tieline.ts` and fails when a row and the code disagree.

| Code | Reason | The hub sends it when | Tie line | Source |
| --- | --- | --- | --- | --- |
| `4400` | `malformed trunk frame` | a frame on `/trunk` does not decode (an off-roster slot, a world that is neither a number nor `NEW`, any undecodable frame) | terminal before `ASSIGNED` — `LINE NOT ACCEPTED — … — CHECK TIELINE_SLOT AND TIELINE_WORLD`; after `ASSIGNED` it is an outage and the line redials with backoff | `server.ts` `trunkWss` `"message"` handler (`decodeTrunkFrame` catch); `tieline.ts` `hub.on("close")` `4400 && !everAssigned` branch |
| `4408` | `no register` | a socket opened `/trunk` and sent no `REGISTER` inside `trunk.registerTimeoutMs` (default 20 s) | redials — a slow host, not a refusal | `server.ts` `trunkWss` `registerTimer` |
| `4409` | `switchboard full` | `Switchboard.register` returns `"full"`: the hub already holds `maxExchanges` exchanges (`trunk.maxExchanges` on `ServerOpts`, default 32) | terminal — `LINE REFUSED — SWITCHBOARD FULL` | `server.ts` `trunkWss` `REGISTER` branch; `trunk.ts` `register()`; `tieline.ts` terminal set |
| `4460` | `no circuits available` | `"no-circuits"`: the world asked for is out of range, or every slot in every eligible world is taken and no new world can be provisioned (`TRUNK_MAX_WORLDS`) | terminal — `LINE REFUSED — NO CIRCUITS AVAILABLE` | same three sites as `4409` (`trunk.ts` `place()`) |
| `4461` | `slot taken` | `"slot-taken"`: the named slot (`TIELINE_SLOT`) in the world asked for is already held | terminal — `LINE REFUSED — SLOT TAKEN` (fixable: ask for another slot or world) | same three sites as `4409` |
| `4462` | `world reserved` | `"world-reserved"`: the world is on the hub's reserved list (`TRUNK_RESERVED_WORLDS`; world 1 is the flagship's own) and the `REGISTER` carried no key matching `TRUNK_RESERVE_KEY` (the line sends `TIELINE_RESERVE_KEY`) | terminal — `LINE REFUSED — WORLD RESERVED` (needs the hub operator's key) | same three sites as `4409`; reservation itself in `trunk.ts` `reserved()` |
| `4463` | `not a hub` | the relay at the far end is a **peer** (a tie line configured **and** no seeded local world): its `/trunk` closes every socket the moment it opens, before a frame is read; its `Switchboard` is built with `maxExchanges: 0` as the second line (#87) | terminal — `LINE REFUSED — NOT A HUB`; a line pointed at a peer is a configuration fault, so it is never redialled | `server.ts` `trunkWss` `isPeer` guard; `tieline.ts` terminal set; `tests/peer-not-a-hub.test.ts` |

The four `REGISTER` refusals are distinct on purpose: the host operator has to tell "this hub
is out of room entirely" (`4409`) from "the world you asked for is out of circuits" (`4460`)
from "someone else already holds that slot" (`4461`) from "that world is not open to you"
(`4462`) — the middle two are fixable by asking for a different world or slot, the last
needs the hub operator's key, and `4463` says the address was never a hub at all.

A tie line that receives a terminal code prints its `LINE REFUSED` line once and stops for
good; anything else (`4408`, a `4400` after `ASSIGNED`, a plain drop, `1006`) is an outage
and the line redials with capped exponential backoff, re-registering for a fresh exchange
code.

```bash
npm install
npm test                 # throughput-at-baud, parity, toggle, FSM, federation, e2e
npm run dev              # service on :8081 (COMMS_MODE, BRIDGE_WS_URL, ...)
npm run dev:bridge-stub  # dev-only fake bridge on :8000 (use when the real bridge is not running)
```

Requires Node ≥ 23.6 (native type-stripping; scripts run `.ts` directly).
