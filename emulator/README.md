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

Every program is still a self-contained subprocess reading one frame on stdin and
writing one on stdout. The harness never reaches inside a program; it only speaks
`WOPR/1`, `SYSTEM/1` and `JOSHUA/1` to it, and treats every `STATE` block as
opaque.
