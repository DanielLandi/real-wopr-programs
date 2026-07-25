# Surface — WOPR Panel

The cabinet itself: banks of blinking lamps and the launch-code readout, inside the NORAD
computer room (film-baseline S11/S13). Spec: [`../../docs/surfaces.md`](../../docs/surfaces.md)
§4.

Observe-only, like the Big Board: on load it opens a session, sends `OBSERVE GTW`, and
follows whatever `GTW-FEED` state the bridge relays ([`app/feed.ts`](./app/feed.ts)).
Lamp agitation scales with DEFCON; the launch code's characters lock in one by one
(scattered, deterministic order) as DEFCON falls, and a `NO-WIN` result flips the readout
to the abort. With no live simulation the panel idles at DEFCON 5 — `RUN DEMO` plays a
self-contained escalation timeline (~1 minute, no backend needed).

All blink patterns derive from a deterministic position/epoch hash (no `Math.random`),
the same discipline as crt-kit's modem-noise LCG.

Dev: `npm run dev -w @real-wopr/wopr-panel` (port 3003). Static export lands in `out/`,
served under `/panel` (deployment.md D3).
