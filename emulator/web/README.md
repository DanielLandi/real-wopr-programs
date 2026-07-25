# Module 6 — Surfaces

**Tech:** Next.js (React) + shared CRT component library · **Spec:** [`../docs/surfaces.md`](../docs/surfaces.md)

Five separately-deployable front-ends — most behind a distinct simulated link — all
sharing the `crt-kit` aesthetic core (scanlines, phosphor glow, link-driven `<Teletype>`,
handshake view).

| App | Vantage | Simulated link |
| --- | --- | --- |
| `home-terminal/` | David's bedroom | Dial-up ~300 baud, full handshake |
| `norad-terminal/` | Operator console | Leased line, faster, framed |
| `norad-bigboard/` | War-room map | Internal bus, fastest (graphical) |
| `wopr-panel/` | The cabinet itself | Internal bus, observe-only (graphical) |
| `norad-warroom/` | The war room as a wall | None of its own — composes the three NORAD-side surfaces as synchronized iframes |
| `crt-kit/` | — | Shared component library (not deployed alone) |

## Status

npm **workspace** (`surfaces/package.json`): `crt-kit` is symlinked into each app and
consumed as raw TSX via `transpilePackages`. Apps build as **static exports**
(deployment.md D1) and use same-origin relative URLs (D3).

All five apps are implemented; see each app's README for its behavior and dev port.

```bash
npm install                 # once, from surfaces/
npm run build               # static-exports every app
npm run dev:home            # home terminal on :3000 -> /terminal
npm run dev:norad           # NORAD operator terminal on :3001 -> /norad
npm run dev:bigboard        # NORAD Big Board on :3002 -> /bigboard
npm run dev:panel           # WOPR cabinet panel on :3003 -> /panel
npm run dev:warroom         # NORAD screen wall on :3004 -> /warroom
```

For local bridge/comms integration, set the same environment for each app:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000 \
NEXT_PUBLIC_COMMS_URL=ws://localhost:8081/link \
npm run dev:bigboard
```
