# The WOPR Program Pack format

A **pack** is a collection of period-language programs that a W.O.P.R. engine can build, test,
and host. This repository is one pack; you can publish your own.

## A program

Each program is a directory with its **source at the top** and a `harness/` beside it:

```
<category>/<id>/
  <source files>          # the program, in a period language
  data/                   # optional: fixed-width flat data files, read-only
  harness/
    manifest.json         # metadata (below)
    build.sh              # builds the source -> harness/bin/<binary>
    tests/                # golden fixtures: NN.in reproduces NN.out byte-for-byte
```

- `build.sh` runs from its own directory, reads the source from `..`, and writes an executable
  to `bin/<binary>`. Interpreted or emulated programs (BASIC, 6502) ship a small wrapper as
  `bin/<binary>` that runs the source under its interpreter or emulator.
- A **game slot with several interpretations** nests one complete program per reconstruction —
  `games/<id>/<interpretation>/` with this same layout inside each — instead of the flat
  `games/<id>/`. See CONTRIBUTING.md "Reinterpret an existing game".
- A program may keep committed, read-only **data files** under `data/` — fixed-width flat
  records, the era's file technology — and re-read them at every spawn. The program never
  writes them (mutations travel in the `STATE` block like everything else), nothing outside
  the program knows their layout, and because they are committed bytes they do not disturb
  determinism. A program whose binary is not a wrapper script ships one anyway, chdir-ing to
  the program folder so relative paths resolve wherever the host spawns it from.
- The built `bin/<binary>` reads **one request frame** on stdin and writes **one response
  frame** on stdout, then exits. It keeps no state between calls — any state travels in the
  frames. A rule violation writes a well-formed error frame and exits non-zero.
- Determinism is required: the same request bytes must produce the same response bytes. No wall
  clock, no unseeded randomness — seed any randomness from the request.

## manifest.json

```json
{
  "id": "hearts",
  "title": "HEARTS",
  "binary": "hearts",
  "language": "fortran"
}
```

`id`, `title`, and `binary` are required. Games add `players`, an optional `input_syntax`,
and an **`abbrev`** — a short label the monitor puts in the user's prompt while the
terminal is attached to this game (`[TTT]>`). Omit it and the game's id is used.

A game does not declare how to recognise its own moves. The terminal is attached to
one program at a time, so while a game is running everything typed goes to it.
Systems add their own fields. The engine reads the manifest to route and present the
program.

### `node` — becoming an endpoint

A program that is not just something another program runs, but a machine you can *reach*,
adds a `node` block. It says which networks the program answers on, what address it answers
at, what it runs locally, which peers it may call, and which programs it may hand the
terminal to. This is `systems/school-mon` — the school district's login monitor, which
answers the phone and runs the records program for whoever gets past it:

```json
"node": {
  "networks": {
    "pstn": { "address": "(206) 555-0142", "protocol": "SYSTEM/1" },
    "bus":  { "address": "SCHOOL-MON",     "protocol": "SYSTEM/1" }
  },
  "execs": ["school"],
  "peers": ["school-ada"]
}
```

That is the block as it ships, verbatim. Everything below `networks` is optional
and defaults to the quiet answer, so a real manifest declares only what it
actually claims — spelling the defaults out would teach a house style the pack
does not use.

| Field | Meaning |
| --- | --- |
| `networks` | Which networks this answers on, and at what address. Networks are declared once in `pack.json`. |
| `mounts` | Program ids or globs (`games/*`) this node runs locally, as subprocesses. |
| `peers` | Node ids this may `CALL` — ask a question of, mid-turn, and be resumed with the answer. `systems/school` declares `"peers": ["school-db"]`. A node with no `peers` cannot make calls at all. |
| `execs` | Program ids this may `EXEC` — *hand the terminal to*, rather than ask. The program taking over owns the session until it says `LINE RETURN`, and never learns it was exec'd. A program id here need not be a node: an exec'd program is run by whoever is serving the call, not dialled. Undeclared targets are rejected before anything runs. See [`docs/systems.md` §2.6](https://github.com/DanielLandi/real-wopr/blob/main/docs/systems.md) for the wire format and the return stack. |
| `state` | `ephemeral` (default) or `persistent`. `persistent` makes the host own this program's `STATE` between calls — what a data store needs. |
| `callable_by` | Node ids permitted to call this one. Omit for "anyone sharing a network". |

`peers` and `execs` are different verbs and are checked separately: `CALL` gets you an answer
and keeps the terminal, `EXEC` gives the terminal away.

**A program with no `node` block is not a node** — it is somebody's mount. The games are
mounts: `GTW` is not something you dial, it is something W.O.P.R. runs for you.

A node's declaration is checked before anything runs: unknown networks, duplicate addresses,
unknown or unreachable peers, undeclared `EXEC` targets, empty mount globs and cycles are all
rejected.

## The executive

`wopr/` is the pack's fourth category and holds exactly one program: **the W.O.P.R. executive**,
the connection monitor that owns a terminal session. It has the same layout as any other program
— source at the top, `harness/{manifest.json,build.sh,tests/}` beside it — and is built,
golden-tested and packaged like one. What makes it different is only what it decides: the front
door, what the terminal is attached to, the reserved words, and W.O.P.R.'s own voice. It speaks
SYSTEM/1 and reaches the games and the dialogue processor with `CALL`.

## Wire protocols

A program speaks exactly one line-oriented ASCII protocol, named in `pack.json`:

- **WOPR/1** — the games. `WOPR/1 <id> <NEW|MOVE|QUERY>` in; opaque state + display + status out.
- **SYSTEM/1** — the dial-in systems and the executive. `SYSTEM/1 <id> <CONNECT|INPUT>` in;
  state + display out.
- **JOSHUA/1** — the dialogue engine. A `CHAT` frame carrying the conversation `HISTORY` in; a
  reply out.

The protocols are designed so a golden fixture pair (`NN.in` / `NN.out`) fully specifies a turn.
They are documented in full in the engine's docs, linked from [realwopr.ai](https://realwopr.ai).

### Asking another program for something

A program may end a turn by asking its host to reach **one peer**, and will be re-invoked with
the answer. `WOPR/1` and `SYSTEM/1` both carry it:

```
CALL <peer> <n>              <- last block of a response, before STATUS / LINE
<n payload lines>

REPLY <peer> <status> <n>    <- last block of the next request, before END
<n payload lines>
```

- The payload is **opaque to the harness**, exactly as `STATE` is. Only the two programs
  understand it.
- At most one `CALL` per response. A program needing two answers asks twice — which keeps the
  state machine explicit and the fixtures readable.
- `<status>` is `OK`, `FAIL` or `TIMEOUT`. Programs **must** handle the failure cases: a
  subsystem being down was an ordinary Tuesday in 1983, and the honest behaviour is a period
  error message, not a hang.
- The host bounds a turn at 4 chained calls; cycles are rejected earlier, when the topology is
  validated.
- A `CALL` may not accompany `LINE DROP` (SYSTEM/1) or a terminal `STATUS` (WOPR/1) — a
  continuation needs something to resume into.

This is the shape a 1983 transaction programmer actually wrote: the program ends, and the
monitor restarts it with its saved context when the answer arrives. `STATE` is the COMMAREA. In
bwBASIC it is a `PRINT "CALL ..."` and a branch on a phase tag; in COBOL a `DISPLAY` plus an
`EVALUATE` on a field saved into the state block. `echo frame | ./binary` still works with
nothing else running, and a golden fixture just carries a canned `REPLY`.

`systems/school-db` is the worked example — the school district's records as a separate
program, reached over the local bus rather than a phone line.

### Telling a program what it cannot know

A SYSTEM/1 request may carry one optional `FACTS` block, after `INPUT` and
before any `REPLY`:

```
FACTS 4
GAME GTW IMPLEMENTED TRAILING GLOBAL THERMONUCLEAR WAR
GAMEROW GTW PLAYING 4
DEFCON 5
SURFACE HOME-TERMINAL
```

Card images, counted like `STATE`, carrying what the program cannot know for
itself: durable state that other surfaces share and can change behind its back.
They are sent **every turn** rather than seeded once, so a program never decides
from a cached copy of something that has since moved, and stays a pure function
of `(frame, STATE)`. The block's contents are between the host and that one
program; a program that ignores it parses exactly as it did before the block
existed.

### Asking the user for something

A SYSTEM/1 response may end with one optional `PROMPT` line, between the
`DISPLAY` block and `LINE`:

```
PROMPT <text>            <- optional: what the system is asking
LINE UP
```

The harness delivers it out-of-band to the terminal's input line (the way game
monitors already deliver `[TTT]>`), so the cursor rests after the question the
way a real remote host left it. At most one per response; it may not accompany
`LINE DROP` (a dropped line asks nothing) or a `CALL` continuation (a program
mid-continuation is not ready for input). A response without `PROMPT` renders
exactly as before, so old-style programs are untouched.

## pack.json

The pack index at the repository root:

```json
{
  "pack": "real-wopr-programs",
  "version": "1.0.0",
  "author": "...",
  "homepage": "https://realwopr.ai",
  "programs": [
    { "id": "hearts", "kind": "game", "protocol": "WOPR/1",
      "language": "fortran", "path": "games/hearts", "binary": "hearts" }
  ]
}
```

`kind` is `game` | `system` | `joshua`. `path` is the program directory. `programs[]` here, and
`emulator/web/home-terminal/app/dial-systems.generated.ts`, are both **generated** from every
`harness/manifest.json` by `tools/gen-dial-directory.py` — the manifest is the one authority for
a program's id, and a hand edit to either generated file is a lint failure waiting to happen:

```
tools/gen-dial-directory.py            # regenerate both from the manifests
tools/gen-dial-directory.py --check    # exit 1 if either is stale (what CI runs)
```

A `systems/` manifest that declares a `number` becomes **dialable**, and
`emulator/web/home-terminal/app/sims.ts` must account for it — listed in the phone book or
explicitly excluded in `UNLISTED` with a reason. That file throws at import if a dialable system
is mentioned nowhere in it, so a new dial-in system that regenerates cleanly but is never
mentioned in `sims.ts` fails loudly instead of silently missing the directory.

## Packaging

`make pack` bundles `pack.json` and every program (source + harness + tests, without build
output) into `dist/real-wopr-programs.woprpack` — a gzip tarball. That single file is what an
operator imports into their engine, and it is how a fan distributes their own pack.
