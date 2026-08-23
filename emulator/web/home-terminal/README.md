# Surface — Home Terminal

David Lightman's bedroom. Dial-up, ~600 baud, full handshake. Slow, intimate, text-only.
Spec: the engine repo's `docs/surfaces.md`.

Everything renders at link speed — the comms layer's `dialup-600` profile owns the cadence;
this page only appends what arrives.

- **Phone book** — if `phonebook.json` is served next to the export, the terminal lists
  community exchanges and can war-dial them (`SCAN FOR CARRIERS`); without one it dials the
  same-origin exchange ([`app/exchanges.ts`](./app/exchanges.ts)).
- **Local numbers (S2/S9)** — David's list also carries two dial-in easter eggs that run
  entirely in-page: a school district data net (password from the office list, student
  records, grade edits) and an airline reservation system (availability, seat booking).
  [`app/sims.ts`](./app/sims.ts) — its `LocalSimLink` speaks WoprLink's event surface, so
  the dial ritual, modem audio, and 600-baud reveal are the real ones.
- **VOICE toggle (S10)** — top-right; feeds completed output lines to crt-kit's
  `JoshuaVoice` (Web Speech, pitched down). Off by default; the click is the enabling
  user gesture.

## Query parameters

Experiment parameters, set before the run by whoever is running it. None appear in the
terminal's own grammar — this is a 1983 machine, and a selector inside it would be a modern
concept living in the period device.

| Parameter | Effect |
| --- | --- |
| `?room=` | join a shared GTW room (6 characters) |
| `?api=`, `?link=` | point at a specific exchange's bridge and comms |
| `?joshua=` | which reconstruction of Joshua answers this session |

`?joshua=lisp` or `?joshua=claude` picks the dialogue processor for one session, which
leaves `JOSHUA_ENGINE` as nothing more than the exchange's default. Both are the same
character: `lisp` is the period Falken Dialogue Processor, `claude` a modern model reaching
for what the film depicts. Which gets closer is the open question — `evals/warmth_eval.py`
in the engine repo measures it.

An exchange serves only what it has configured; `GET /health` lists that as
`joshua_processors`. Asking for anything else refuses the session rather than quietly
substituting, and the reason is logged to the browser console — the terminal has no 1983
words for it and will simply report no carrier.

Dev: `npm run dev:home` from `emulator/web/` (port 3000, needs `NEXT_PUBLIC_API_URL` +
`NEXT_PUBLIC_COMMS_URL` — see [`../README.md`](../README.md)). Static export lands in `out/`,
served at `/` (deployment.md D3); the public site commits a copy under `terminal/`
(regenerate it after changing this surface — commands in real-wopr-site's README).
