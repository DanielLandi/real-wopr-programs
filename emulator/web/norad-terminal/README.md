# Surface — NORAD Terminal

Operator console inside NORAD. Leased line, faster, framed. Authoritative, command-oriented.
Spec: [`../../docs/surfaces.md`](../../docs/surfaces.md).

**Status:** implemented as an operator console. It opens a `norad-terminal`
session, connects through the comms layer, and offers a two-step operator
logon (`LOGON <CALLSIGN>` → masked `ACCESS CODE:`) backed by the bridge's
`WOPR_OPERATORS` roster; the clearance/DEFCON/link header goes live
(`<CALLSIGN> L<n>`) once logon succeeds. Logged-in operators get a tactical
command tier — `SITREP`, `TRACKS`, `EVENTS`, `SET DEFCON <n>` — plus the
existing game verbs, and `WALL`, which prints the screen-wall URL for the
current room as a surface-side handoff. Joshua still requires the film's
`JOSHUA` backdoor.

Dev: `npm run dev:norad` from `surfaces/` (port 3001, served under `/norad`).
