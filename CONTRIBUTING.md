# Contributing

These are the period-language programs behind [realwopr.ai](https://realwopr.ai), plus the
modern harness that runs them. The guiding rule is fidelity to the era: a program stays within
constructs its language plausibly had in the early 1980s, and it says so when it approximates.

## Submitting a change

`main` is protected: everything lands through a pull request with CI green.

1. Fork, then branch from `main`.
2. Make the change. If you touched a program, `make test` must be green locally before you
   push — the goldens are the spec.
3. Open a PR. All nine `pack` jobs must pass (`programs`, `node`, `relay`, `web`, `devkit`,
   `images`, `terminal`, `federation`, `cli`); they build every program with real period
   toolchains (gfortran, sbcl, gnucobol, bwbasic, cc65, gcc) and diff every golden fixture
   byte-for-byte.
4. A maintainer merges with squash, so your PR lands as one commit.

**If you changed behavior on purpose**, regenerate the affected fixtures and review the diff
line by line before pushing. A regenerated `.out` that you did not read is not a test — it is
a recording of whatever the code now does.

First PR from a fork? GitHub will hold the workflow run until a maintainer approves it. That
is GitHub's default for new contributors, not a problem with your PR.

Participation is covered by the [Code of Conduct](./CODE_OF_CONDUCT.md). Found a security
problem rather than a bug? Do not open an issue — [SECURITY.md](./SECURITY.md) has the private
reporting path.

## Which half are you changing?

**A program** (`games/`, `systems/`, `joshua/`, `wopr/`) — stay in period. Fortran within F77/F90
constructs, Lisp within CLtL1-era forms, no modern conveniences. Golden fixtures are the test
suite and must reproduce byte-exact. Document approximations rather than hiding them.

**The harness** (`emulator/`) — write ordinary modern code. Python 3.11+, Node 23.6+. No
period constraints apply; the harness is a modern emulator and says so.

The line matters: the harness must never reach inside a program. It speaks `WOPR/1`,
`SYSTEM/1` and `JOSHUA/1`, and treats every `STATE` block as opaque.

**One documented exception**, and only one: `wopr/`, the executive, is a program the harness
*is the I/O of* — the same relationship [PACK.md](./PACK.md) already describes for a mount's
`CALL` payload, whose first line the harness reads. The executive's `STATE` block opens with a
header line the harness reads and nothing else:

```
MODE <FRONT-DOOR|JOSHUA|GAME|NORAD-OPS> <program|-> <PENDING|-> <BACKDOOR|->
```

That is what tells a reconnecting terminal whether it is still at the front door and must be
re-greeted, and what makes the harness write `[REDACTED]` into the event log instead of an
operator's access code. Everything below that line is the executive's own business, and no
other program's `STATE` is read at all.

## The contract: golden fixtures

Each program's `harness/tests/` holds golden fixtures — `NN-name.in` paired with `NN-name.out`.
The program is correct when every `.in` reproduces its `.out` byte-for-byte through the built
binary. Fixtures whose name contains `error` must exit non-zero (a well-formed protocol error).

```
make test                                      # every program
tools/test.sh wopr                             # one category: games | systems | joshua | wopr
games/hearts/harness/build.sh                  # build one program
games/hearts/harness/bin/hearts < games/hearts/harness/tests/01-new.in
```

## Change an existing program

1. Edit the source at the top of the program's folder (e.g. `games/hearts/main.f90`).
2. Rebuild it: `games/hearts/harness/build.sh`.
3. If the behavior changed on purpose, regenerate the affected fixtures and **review the diff
   line by line** — the goldens are the spec:
   ```
   cd games/hearts/harness
   for f in tests/*.in; do bin/hearts < "$f" > "${f%.in}.out"; done
   ```
4. Make sure `make test` stays green.

## Add a program

1. Create `<category>/<id>/` with your source at the top and a `harness/` beside it.
2. Write `harness/manifest.json` (`id`, `title`, `binary`, `language`), `harness/build.sh`
   (reads the source from `..`, writes `bin/<binary>`), and `harness/tests/` golden pairs.
3. Speak one of the wire protocols in [PACK.md](./PACK.md): one request frame in, one response
   frame out, deterministic, and stateless between calls.
4. Regenerate the index: `tools/gen-dial-directory.py`. It derives `pack.json`'s `programs[]`
   (and, for `systems/`, the dial directory) from every `harness/manifest.json` — manifests are
   the authority, and CI runs `tools/gen-dial-directory.py --check`, so a hand-edited or stale
   `pack.json` fails the build. If your new program is a `systems/` entry with a `number` (it
   answers a phone line), it is now **dialable**, and `emulator/web/home-terminal/app/sims.ts`
   must say what to do with it: list it to put it in the phone book, or exclude it in `UNLISTED`
   with a reason. Import throws at build/test time otherwise, naming the id.
5. `make build && make test`.

## Reinterpret an existing game

A catalog slot can hold several competing reconstructions of the same title — the pack calls
them **interpretations**. Yours does not replace the official one; it sits beside it, and a
player finds it by asking (`LIST CHESS` at the terminal lists a slot's interpretations;
starting a title bare always runs the official one).

1. A slot with one implementation is flat (`games/<id>/`). Your PR converts it:
   `games/<id>/<interpretation>/`, one subdirectory per interpretation, each a complete
   program with its source at the top and its own `harness/{manifest.json,build.sh,tests/}`.
   Move the existing program into `games/<id>/core/` unchanged.
2. Pick a short lowercase `interpretation` name, set it in your manifest along with your
   `author`, and keep the slot's `id`/`title` identical across interpretations.
3. Your golden fixtures are yours alone; the existing interpretation's fixtures must still
   pass byte-exact. CI builds and tests every interpretation in the slot.
4. Save state is not portable between interpretations — the `STATE` block is your program's
   own; a `LOAD` of foreign state should fail your program's normal way.

Same wire protocol, same determinism and period rules as any program. The official
real-wopr implementations carry `"author": "core"`.

## Determinism and period discipline

- Same request bytes ⇒ same response bytes. No wall clock; seed any randomness from the request.
- Stay within period-plausible language constructs, and document approximations rather than
  hiding them.
- No film assets, audio, or transcript text. The short canonical lines already present are the
  ceiling.

## Sharing your own pack

You do not need to contribute here to be hosted. Any collection of programs following this
layout and the [PACK.md](./PACK.md) format is a valid pack — bundle it with `make pack` and an
operator can import your `.woprpack` alongside this one.
