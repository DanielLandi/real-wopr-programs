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
| `TIELINE_SLOT` | `WOPR` `SCHOOL` `PANAM` `PROTOVISION` `PACTEL` `HOME` `OTHER-1` `OTHER-2` |
| `TIELINE_WORLD` | a world number, or `NEW` for a fresh world (default: lowest world with the slot open) |
| `TIELINE_NAME` / `TIELINE_REGION` / `TIELINE_OPERATOR` | how the phone book lists you |
| `TIELINE_JOSHUA` | `period` (default) or `claude` |
| `TRUNK_HUB_URL` | defaults to `wss://wopr.realwopr.ai/trunk` |
| `BRIDGE_LOGON_BANNER`, `WOPR_OPERATORS` | your exchange's banner and operator roster — local to your machine, never sent anywhere |

Anything in that table can live in a `.env` file at the pack root instead of on
the command line — `make host` sources it (it is gitignored). The command line
wins: a variable already set in your shell keeps its value, so you can override
a line in the file for one run without editing it.

`https://realwopr.ai/host.html` generates this command from a form.
