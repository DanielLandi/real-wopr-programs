# The WOPR Program Pack format

A **pack** is a collection of period-language programs that a W.O.P.R. engine can build, test,
and host. This repository is one pack; you can publish your own.

## A program

Each program is a directory with its **source at the top** and a `harness/` beside it:

```
<category>/<id>/
  <source files>          # the program, in a period language
  harness/
    manifest.json         # metadata (below)
    build.sh              # builds the source -> harness/bin/<binary>
    tests/                # golden fixtures: NN.in reproduces NN.out byte-for-byte
```

- `build.sh` runs from its own directory, reads the source from `..`, and writes an executable
  to `bin/<binary>`. Interpreted or emulated programs (BASIC, 6502) ship a small wrapper as
  `bin/<binary>` that runs the source under its interpreter or emulator.
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
and a **`move_pattern`** — an anchored regex (compiled case-insensitively) that tells the
engine which typed inputs are this game's moves vs. ordinary chat, so a game routes without
any engine-side edit. Systems add their own fields. The engine reads the manifest to route
and present the program.

## Wire protocols

A program speaks exactly one line-oriented ASCII protocol, named in `pack.json`:

- **WOPR/1** — the games. `WOPR/1 <id> <NEW|MOVE|QUERY>` in; opaque state + display + status out.
- **SYSTEM/1** — the dial-in systems. `SYSTEM/1 <id> <CONNECT|INPUT>` in; state + display out.
- **JOSHUA/1** — the dialogue engine. A `CHAT` frame carrying the conversation `HISTORY` in; a
  reply out.

The protocols are designed so a golden fixture pair (`NN.in` / `NN.out`) fully specifies a turn.
They are documented in full in the engine's docs, linked from [real-wopr.ai](https://real-wopr.ai).

## pack.json

The pack index at the repository root:

```json
{
  "pack": "real-wopr-programs",
  "version": "1.0.0",
  "author": "...",
  "homepage": "https://real-wopr.ai",
  "programs": [
    { "id": "hearts", "kind": "game", "protocol": "WOPR/1",
      "language": "fortran", "path": "games/hearts", "binary": "hearts" }
  ]
}
```

`kind` is `game` | `system` | `joshua`. `path` is the program directory. Regenerate the index
after adding a program, or edit it by hand.

## Packaging

`make pack` bundles `pack.json` and every program (source + harness + tests, without build
output) into `dist/real-wopr-programs.woprpack` — a gzip tarball. That single file is what an
operator imports into their engine, and it is how a fan distributes their own pack.
