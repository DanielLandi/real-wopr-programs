# real-wopr-programs

The period-language programs behind **[realwopr.ai](https://realwopr.ai)** — a technical
reconstruction of the W.O.P.R. from *WarGames* (1983), with each program written
in a language of its era.

This repository holds **both halves**, and keeps them visibly apart:

- The **programs** — `wopr/`, `games/`, `systems/`, `joshua/` — are period source. Fortran, COBOL,
  BASIC, 6502 assembly, CLtL1-era Lisp. They are the reason to be here.
- The **harness** — `emulator/` — is a modern Python/TypeScript runtime that hosts those
  programs on a modern computer. It is openly modern and does not pretend otherwise.

You do not need the harness to read, change, build, or test a program. You do need it to run
the whole machine, and `git clone` gets you both.

## What's inside

| Folder | Programs | Language | Protocol |
|---|---|---|---|
| `games/` | tictactoe, gtw, blackjack, checkers, falkens-maze, gin-rummy, hearts, poker | Fortran | WOPR/1 |
| `systems/` | airline (Pan Am), school (Seattle), protovision, pactel (Pacific Telephone), reference, umb (Union Marine Bank) | COBOL, BASIC, 6502 asm, C | SYSTEM/1 |
| `joshua/` | the Falken Dialogue Processor | Common Lisp | JOSHUA/1 |

Every program is a self-contained subprocess: it reads one request frame on standard input
and writes one response frame on standard output. Nothing talks over a network; nothing keeps
state between calls.

And beside them, the harness that runs them:

| Folder | What it is | Language |
|---|---|---|
| `emulator/relay/` | The networks — era shaping (600 baud), dial FSM, switchboard | TypeScript |
| `emulator/node/` | The host that runs programs as subprocesses and serves the API | Python |
| `emulator/web/` | Browser surfaces — a proxy onto what the programs do | TypeScript/Next.js |
| `emulator/devkit/` | A period line-mode IDE for editing and building programs | Python |

See [`emulator/README.md`](./emulator/README.md) for how to run it.

## Layout

Each program keeps its **source alone** at the top of its folder, so you can open it and see
only the thing you would change. Everything else — the build script, the manifest, and the
golden test fixtures — sits in a `harness/` folder beside it.

```
games/hearts/
  main.f90            <- the program
  harness/
    manifest.json     <- what it is (id, title, binary, ...)
    build.sh          <- builds main.f90 -> bin/hearts
    tests/            <- golden fixtures (NN.in must reproduce NN.out)
```

## Build and test

Each program builds on its own; the top-level `make` runs them all.

```
make build      # build every program (needs the per-language toolchains — see toolchain.md)
make test       # build, then golden-test every program
make pack       # bundle everything into dist/real-wopr-programs.woprpack
```

One program on its own:

```
games/hearts/harness/build.sh
games/hearts/harness/bin/hearts < games/hearts/harness/tests/01-new.in
```

## Change, fork, or add a program

See [CONTRIBUTING.md](./CONTRIBUTING.md). In short: the golden fixtures are the contract — a
change is done when the program still reproduces them (or you regenerate them and review the
diff). To add your own program, follow the same source + `harness/` shape and one of the wire
protocols in [PACK.md](./PACK.md). A catalog slot can also hold competing reconstructions of
one title — interpretations — credited per slot in [CREDITS.md](./CREDITS.md).

## Using these with the engine

The programs are distributed as a **pack** — a single `real-wopr-programs.woprpack` file
(`make pack`) indexed by `pack.json`. An operator running the W.O.P.R. engine imports the pack
to build and host the programs. The format is open, so anyone can publish their own pack of
period-language programs and have it hosted the same way. See [PACK.md](./PACK.md).

## Credit

*WarGames* is © MGM/UA. This is a fan reconstruction: it contains no film assets, audio, or
transcripts. The short canonical lines that appear are the ones already spoken on screen.

## License

Copyright (C) 2026 Daniel Landi and contributors.

This repository — the period programs, the `emulator/` harness, and the pack
tooling — is licensed under the GNU General Public License v3.0 **or later**
(SPDX: `GPL-3.0-or-later`). See [LICENSE](./LICENSE). Forks and modified
packs must stay under the same license, which keeps every reconstruction
re-importable by any exchange, including this one's.
