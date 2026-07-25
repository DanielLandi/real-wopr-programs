# Surface — Home Terminal

David Lightman's bedroom. Dial-up, ~300 baud, full handshake. Slow, intimate, text-only.
Spec: [`../../docs/surfaces.md`](../../docs/surfaces.md).

Everything renders at link speed — the comms layer's `dialup-300` profile owns the cadence;
this page only appends what arrives.

- **Phone book** — if `phonebook.json` is served next to the export, the terminal lists
  community exchanges and can war-dial them (`SCAN FOR CARRIERS`); without one it dials the
  same-origin exchange ([`app/exchanges.ts`](./app/exchanges.ts)).
- **Local numbers (S2/S9)** — David's list also carries two dial-in easter eggs that run
  entirely in-page: a school district data net (password from the office list, student
  records, grade edits) and an airline reservation system (availability, seat booking).
  [`app/sims.ts`](./app/sims.ts) — its `LocalSimLink` speaks WoprLink's event surface, so
  the dial ritual, modem audio, and 300-baud reveal are the real ones.
- **VOICE toggle (S10)** — top-right; feeds completed output lines to crt-kit's
  `JoshuaVoice` (Web Speech, pitched down). Off by default; the click is the enabling
  user gesture.

Dev: `npm run dev:home` from `surfaces/` (port 3000, needs `NEXT_PUBLIC_API_URL` +
`NEXT_PUBLIC_COMMS_URL` — see the `local-stack` skill). Static export lands in `out/`,
served at `/` (deployment.md D3); the public site commits a copy under `terminal/`
(regenerate it after changing this surface — commands in real-wopr-site's README).
