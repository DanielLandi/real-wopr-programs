# real-wopr-programs

The period-language programs behind **[real-wopr.ai](https://real-wopr.ai)** — a faithful
technical reconstruction of the W.O.P.R. from *WarGames* (1983), with each program written
in a language of its era.

This repository holds the **programs only**: the games W.O.P.R. plays, the Joshua dialogue
engine, and the systems you can dial from the terminal. The modern engine that hosts them —
the bridge, the comms layer, the web surfaces — lives in a separate repository. You do not
need it to read, change, build, or test a program here.

## What's inside

| Folder | Programs | Language | Protocol |
|---|---|---|---|
| `games/` | tictactoe, gtw, blackjack, checkers, falkens-maze, gin-rummy, hearts, poker | Fortran | WOPR/1 |
| `systems/` | airline (Pan Am), school (Goose Lake), protovision, pactel (Pacific Telephone), reference | COBOL, BASIC, 6502 asm, C | SYSTEM/1 |
| `joshua/` | the Falken Dialogue Processor | Common Lisp | JOSHUA/1 |

Every program is a self-contained subprocess: it reads one request frame on standard input
and writes one response frame on standard output. Nothing talks over a network; nothing keeps
state between calls.

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
protocols in [PACK.md](./PACK.md).

## Using these with the engine

The programs are distributed as a **pack** — a single `real-wopr-programs.woprpack` file
(`make pack`) indexed by `pack.json`. An operator running the W.O.P.R. engine imports the pack
to build and host the programs. The format is open, so anyone can publish their own pack of
period-language programs and have it hosted the same way. See [PACK.md](./PACK.md).

## Credit

*WarGames* is © MGM/UA. This is a fan reconstruction: it contains no film assets, audio, or
transcripts. The short canonical lines that appear are the ones already spoken on screen.
