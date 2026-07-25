# emulator/ — the modern harness

The folders above this one (`games/`, `systems/`, `joshua/`) hold **programs**:
period source, written the way it was written in 1983, tested by byte-exact
golden fixtures.

This folder holds the **harness** that runs them on a modern computer. It is
openly modern and does not pretend otherwise — Python and TypeScript, chosen for
practicality. Reading it tells you nothing about 1983; reading the programs does.

| Folder | What it is |
| --- | --- |
| `relay/` | The networks. Era shaping (300 baud), dial FSM, switchboard. TypeScript. |
| `node/` | The host that runs programs as subprocesses and serves the API. Python. |
| `web/` | Browser surfaces — a proxy onto what the programs do. TypeScript/Next.js. |
| `devkit/` | A period line-mode IDE for editing and building programs. Python. |
| `cli/` | `wopr` — brings the federation up and dials it. TypeScript. |

## Running it

```bash
make build          # every period program
make up             # three relays, one process per node
```

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
