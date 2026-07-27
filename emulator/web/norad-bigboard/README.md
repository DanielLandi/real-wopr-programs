# Surface — NORAD Big Board

The war-room command view. Internal bus, fastest. Graphical: vector world map, animated
missile trajectories, track labels, DEFCON board. Spec:
the engine repo's `docs/surfaces.md`.

On load it opens a session, sends `OBSERVE GTW`, and renders whatever `GTW-FEED` state the
bridge relays ([`app/feed.ts`](./app/feed.ts)). With no live simulation it shows STANDBY.

**Map modes** (`MAP:` toggle in the header): `WORLD` is the equirectangular default;
`POLAR` is an azimuthal-equidistant disc centered on the North Pole — trajectories follow
the true great circle over the pole, the film's most iconic board geometry
(the engine repo's `docs/fidelity-notes.md` §3). Trajectory colors: red = inbound to the US, amber = inbound
to the USSR, per the production's multi-color vector art.

A second route, `/tracks`, exports the TACTICAL TRACKS monitor — a leaner view of the
same GTW feed, consumed by the screen wall (`norad-warroom`) rather than a browser.

Dev: `npm run dev -w @real-wopr/norad-bigboard` (port 3002). Static export lands in `out/`,
served under `/bigboard` (deployment.md D3).
