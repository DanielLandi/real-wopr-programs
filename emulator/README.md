# emulator/ — the modern harness

The folders above this one (`wopr/`, `norad/`, `games/`, `systems/`, `joshua/`) hold **programs**:
period source, written the way it was written in 1983, tested by byte-exact
golden fixtures.

This folder holds the **harness** that runs them on a modern computer. It is
openly modern and does not pretend otherwise — Python and TypeScript, chosen for
practicality. Reading it tells you nothing about 1983; reading the programs does.

| Folder | What it is |
| --- | --- |
| `relay/` | The networks. Era shaping (600 baud), dial FSM, switchboard. TypeScript. |
| `node/` | The host that runs programs as subprocesses and serves the API. Python. |
| `web/` | Browser surfaces — a proxy onto what the programs do. TypeScript/Next.js. |
| `devkit/` | A period line-mode IDE for editing and building programs. Python. |
| `cli/` | `wopr` — brings the federation up and dials it. TypeScript. |

## Running it

```bash
make build          # every period program
make up             # three relays, one process per node
```

`make up` installs what the harness itself needs the first time it runs — the
relay's and terminal's node modules, and a Python virtualenv for the node host
— because a repository that says you can clone it and run it should not stop
at a missing package. `make deps` does that step alone; `tools/deps.sh --force`
reinstalls.

Then, in another terminal:

```bash
node emulator/cli/src/main.ts dial "(206) 555-0142" --pack .
```

`make map` prints the topology without starting anything. `wopr up --fresh`
discards any persisted store state first.

The shape comes entirely from the pack: `pack.json` declares the networks, and
each program's `harness/manifest.json` declares whether it is a node, what
address it answers, and which peers it may call. Adding a machine is a manifest
edit, not a change here.

Every program is still a self-contained subprocess reading one frame on stdin and
writing one on stdout. The harness never reaches inside a program; it only speaks
`WOPR/1`, `SYSTEM/1` and `JOSHUA/1` to it, and treats every `STATE` block as
opaque.

## Hosting a slot

Any clone of this repo can be a live exchange in the realwopr.ai phone book.
The hub is a switchboard: your machine runs the stack and holds all state;
the hub relays calls and lists your number while your carrier is up. Hang up
(Ctrl-C) and the slot opens again.

```bash
TIELINE_SLOT=SCHOOL TIELINE_NAME="CHEYENNE ANNEX" TIELINE_REGION="SAO PAULO BR" make host
```

| Env | Meaning |
| --- | --- |
| `TIELINE_SLOT` | `WOPR` `SCHOOL` `PANAM` `PROTOVISION` `PACTEL` `BANK` `OTHER-1` `OTHER-2`. There is no `HOME` slot: that is the caller's own seat — David's desk — and it cannot be claimed. |
| `TIELINE_WORLD` | a world number, or `NEW` for a fresh world (default: lowest world with the slot open) |
| `TIELINE_RESERVE_KEY` | only needed to claim a reserved world — world 1 is the flagship's; the hub operator issues it |
| `TIELINE_NAME` / `TIELINE_REGION` / `TIELINE_OPERATOR` | how the phone book lists you |
| `TIELINE_JOSHUA` | `period` (default) or `claude` |
| `TRUNK_HUB_URL` | defaults to `wss://wopr.realwopr.ai/trunk`. Set (and `make host` always sets it), the relay holds the tie line itself and becomes a **peer** — see the topology table below. A relay that seeds its own world 1 is a hub and refuses to hold one. |
| `BRIDGE_LOGON_BANNER`, `WOPR_OPERATORS` | your exchange's banner and operator roster — local to your machine, never sent anywhere |

Anything in that table can live in a `.env` file at the pack root instead of on
the command line — `make host` sources it (it is gitignored). The command line
wins: a variable already set in your shell keeps its value, so you can override
a line in the file for one run without editing it.

`https://realwopr.ai/host.html` generates this command from a form.

`make host` runs **two** processes: the node host, and the relay — which holds
the tie line inside itself. (It used to be three; the tie line moved so that a
call the machine wants to place can go out over the trunk. See the next
section.) `npm run tieline` still runs a tie line standalone, for a stack you
wired yourself.

## Who can ring a visitor back

Joshua rings David's home at the end of the film. Which installations can
actually do that, and how, is the one place the hub/peer distinction leaks into
something a reader has to know.

A **seat handle** — the capability that says "I may ring this person" — is
minted by the **hub**, and it is scoped to a *pair*: the seat, and the exchange
code of the machine that seat dialled. The exchange it was minted for is the only
one that can present it. That single rule explains the whole table.

| | Hub | Flagship (the hub, hosting programs) | Peer (`make host`) |
| --- | --- | --- | --- |
| Runs a `Switchboard` with exchanges in it | yes | yes | no — it has one, and nothing registers with it |
| Seeds its own world 1 (`TRUNK_LOCAL_WORLD`) | maybe | yes | no |
| Holds a tie line (`TRUNK_HUB_URL`) | no | no | yes |
| Mints seat handles | yes | yes | no — the hub mints, against *this* peer's code |
| `POST /trunk/place` goes | to its own switchboard | to its own switchboard, as the seeded `WOPR` | out as a `PLACE` frame on the tie line |

The bridge does not know which of the three it is on, and does not need to: it
posts `{"seat": "<handle>"}` to its own relay (`BRIDGE_TRUNK_URL`) in every case,
and the relay routes it. A peer's relay cannot resolve the handle itself — its
own `SeatRegistry` has never heard of it — so it sends it up the trunk, which is
the only end in the world holding the exchange code the handle was scoped to.
Pointing a peer's `BRIDGE_TRUNK_URL` at the hub instead does not work and cannot
be made to: the peer has no `BRIDGE_INTERNAL_TOKEN` of the hub's, and the hub
would place the call as the flagship's own line.

**When it cannot happen, you are told.** A callback that goes nowhere used to
leave no trace anywhere, which is the actual bug in
[#75](https://github.com/DanielLandi/real-wopr-programs/issues/75). Now:

| | What you see |
| --- | --- |
| Placed | `CALLBACK PLACED — CHAN n` |
| The tie line is down at that moment | `CALLBACK NOT PLACED — TIE LINE DOWN` (stderr) |
| No tie line and no seeded world — nothing to place with | `CALLBACK NOT PLACED — NO TRUNK — …` (stderr) |
| The visitor hung up, or is on another call | `CALLBACK NOT PLACED — SEAT-GONE` / `— BUSY` |
| `BRIDGE_TRUNK_URL` unset | a bridge warning naming the variable |
| A relay configured as both hub and peer | `TIE LINE IGNORED — THIS RELAY IS A HUB …` at startup |

The last row is a guard, not a nicety: a stray `TRUNK_HUB_URL` in a hub's
environment would otherwise have the hub dial itself.

There is no queue and no retry. One intention per conversation, placed the moment
the visitor hangs up — which is the first instant the seat is free to ring, and
the last instant the handle is worth anything.

Design: [`docs/superpowers/specs/2026-08-29-federated-callback-design.md`](../docs/superpowers/specs/2026-08-29-federated-callback-design.md).

## Hub environment

These configure the other end of the trunk — the switchboard itself, the
process that assigns exchange codes and serves `GET /trunk/directory`. If you
are hosting a slot you need none of them; the `TIELINE_*` table above is your
whole surface.

| Env | Meaning |
| --- | --- |
| `TRUNK_PUBLIC_BASE` | the public base baked into every directory entry (default: `http://localhost:<bound port>`). A trailing slash is fine — it is normalized away. |
| `TRUNK_MAX_WORLDS` | how many worlds the hub will open (default 8). A value that is not a whole number >= 1 falls back to the default rather than going unbounded. |
| `TRUNK_RESERVED_WORLDS` | comma list of worlds only a keyed REGISTER may enter (default `1`, the flagship's). Blank or whitespace reads as unset, not as "reserve nothing" — a misconfiguration fails closed. `TRUNK_RESERVED_WORLDS=none` opts out on purpose, which also lets strangers into the flagship's world: don't. |
| `TRUNK_RESERVE_KEY` | the key a tieline sends as `TIELINE_RESERVE_KEY` to enter a reserved world. An empty value unlocks nothing. Dormant while world 1 is self-seeded — nothing needs to claim it. |
| `TRUNK_LOCAL_WORLD` | the hub's own world 1, seeded rather than claimed (below). |
| `BRIDGE_TRUNK_URL` | set on the BRIDGE, not the hub: where the bridge reaches **its own relay's** HTTP API to place a call (`POST /trunk/place`), e.g. `http://comms:8081`. The flagship must set it by hand — bridge and relay are separate containers there. A peer does not: `make host` derives `http://127.0.0.1:$COMMS_PORT`, because on a hosted exchange the relay is on loopback by construction. Unset, Joshua forms the intention to ring a visitor back and rings nobody — and now says so in the bridge log rather than dropping it in silence. Authenticated with the same `BRIDGE_INTERNAL_TOKEN` the two services already share. |

World 1 is not registered by anyone: the hub synthesizes it at startup from
`TRUNK_LOCAL_WORLD`, a JSON array of `{slot, name, region, system?, joshua?}`.
Each seeded entry dials the public base directly — there is no trunk hop,
because the flagship is the hub's own machine — and a slot that is a period
system names the bridge `system` id that opens a session against it
(`airline`, `school-mon`, `pactel`, `protovision`, `reference`, `umb` — a dialable
system is one whose manifest carries a `number`, which is why `school` and
`school-db` are not on that list).

```
TRUNK_LOCAL_WORLD='[
  {"slot":"WOPR","name":"CHEYENNE MOUNTAIN","region":"SAO PAULO BR"},
  {"slot":"SCHOOL","name":"SEATTLE SCHOOL DIST","region":"SEATTLE US","system":"school-mon"}
]'
```

The `system` id has to be the one the home terminal's own paper list uses
(`sims.ts`'s `systemId`). The DIRECTORY screen pairs a seeded world slot with
the paper-list number by matching those two ids, so a slot whose id has gone
stale costs twice over: the machine prints as two lines, and dialling the world
entry names a system the bridge will not open. The school's id became
`school-mon` when it was split into monitor + records (`docs/systems.md` §2.6).

The seeded slot's directory id is the hub's to derive (`local-<slot>`, so
`local-wopr`), never a registry row's. Do not hand-insert the flagship into the
bridge's `exchanges` book under a name of your own: an exchange IS its `api`
endpoint, so the bridge refuses `POST /api/exchanges/register` for an api the
book already holds under another id (409, naming the holder), and the home
terminal lists one line per endpoint — a book row the trunk is already
answering is absorbed by the live, world-tagged entry rather than printed
again as `[NO CARRIER]` (#101).

`slot` comes from the named roster (`WOPR` `SCHOOL` `PANAM` `PROTOVISION`
`PACTEL` `BANK`) — not a wildcard. `name` and `region` are 2-24 characters, the same
bounds the REGISTER wire imposes, because the DIRECTORY screen's 80-column
budget is computed against them. `joshua` defaults to `period`.

A seeded slot is occupied: a tieline asking for it is told the slot is taken,
even with the reserve key. The two ways to get the manifest wrong differ on
purpose — **an invalid manifest (bad slot, duplicate, over-long name) is a
deploy error and the hub refuses to start**, while JSON that will not parse at
all is ignored with one stderr line (`trunk: ignoring malformed
TRUNK_LOCAL_WORLD`) and seeds nothing, so a garbled value cannot take the
switchboard down.
