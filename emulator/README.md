# emulator/ — the modern harness

The folders above this one (`games/`, `systems/`, `joshua/`) hold **programs**:
period source, written the way it was written in 1983, tested by byte-exact
golden fixtures.

This folder holds the **harness** that runs them on a modern computer. It is
openly modern and does not pretend otherwise — Python and TypeScript, chosen for
practicality. Reading it tells you nothing about 1983; reading the programs does.

| Folder | What it is |
| --- | --- |
| `relay/` | The networks. Era shaping (1200 baud), dial FSM, switchboard. TypeScript. |
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
| `TIELINE_SLOT` | `WOPR` `SCHOOL` `PANAM` `PROTOVISION` `PACTEL` `OTHER-1` `OTHER-2`. There is no `HOME` slot: that is the caller's own seat — David's desk — and it cannot be claimed. |
| `TIELINE_WORLD` | a world number, or `NEW` for a fresh world (default: lowest world with the slot open) |
| `TIELINE_RESERVE_KEY` | only needed to claim a reserved world — world 1 is the flagship's; the hub operator issues it |
| `TIELINE_NAME` / `TIELINE_REGION` / `TIELINE_OPERATOR` | how the phone book lists you |
| `TIELINE_JOSHUA` | `period` (default) or `claude` |
| `TRUNK_HUB_URL` | defaults to `wss://wopr.realwopr.ai/trunk` |
| `BRIDGE_LOGON_BANNER`, `WOPR_OPERATORS` | your exchange's banner and operator roster — local to your machine, never sent anywhere |

Anything in that table can live in a `.env` file at the pack root instead of on
the command line — `make host` sources it (it is gitignored). The command line
wins: a variable already set in your shell keeps its value, so you can override
a line in the file for one run without editing it.

`https://realwopr.ai/host.html` generates this command from a form.

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

World 1 is not registered by anyone: the hub synthesizes it at startup from
`TRUNK_LOCAL_WORLD`, a JSON array of `{slot, name, region, system?, joshua?}`.
Each seeded entry dials the public base directly — there is no trunk hop,
because the flagship is the hub's own machine — and a slot that is a period
system names the bridge `system` id that opens a session against it
(`airline`, `school-mon`, `pactel`, `protovision`, `reference` — a dialable
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

`slot` comes from the named roster (`WOPR` `SCHOOL` `PANAM` `PROTOVISION`
`PACTEL`) — not a wildcard. `name` and `region` are 2-24 characters, the same
bounds the REGISTER wire imposes, because the DIRECTORY screen's 80-column
budget is computed against them. `joshua` defaults to `period`.

A seeded slot is occupied: a tieline asking for it is told the slot is taken,
even with the reserve key. The two ways to get the manifest wrong differ on
purpose — **an invalid manifest (bad slot, duplicate, over-long name) is a
deploy error and the hub refuses to start**, while JSON that will not parse at
all is ignored with one stderr line (`trunk: ignoring malformed
TRUNK_LOCAL_WORLD`) and seeds nothing, so a garbled value cannot take the
switchboard down.
