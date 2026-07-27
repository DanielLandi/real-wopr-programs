---
name: fortran-game
description: Work on the WOPR Fortran games — build/golden-test loop, WOPR/1 wire format rules, adding a new game or changing an existing one (tictactoe, gtw). Use when editing anything under games/ or when a task mentions Fortran, gfortran, minimax, GTW, golden fixtures, or the game plugin contract.
---

# Working on the WOPR Fortran games

Ground truth: `../real-wopr/docs/games.md` (wire format + plugin contract; lives in the
engine repo) and `PACK.md` (pack conventions). Period rules: `../real-wopr/docs/games.md` §7.

## The loop

```bash
make build                    # gfortran; games/<id>/main.f90 -> games/<id>/harness/bin/<id>
tools/test.sh games           # every games/*/harness/tests/NN-*.in must reproduce NN-*.out EXACTLY
tools/behavior.sh             # tictactoe self-play NO-WIN + GTW converges to NO-WIN
```

Manual probe: `printf 'WOPR/1 <id> NEW\nSTATE 0\nEND\n' | games/<id>/harness/bin/<id>`

## Iron rules

1. **Wire format is exact** (games.md §2): `WOPR/1 <id> <NEW|MOVE|QUERY>` / `STATE <n>` /
   state lines / optional `INPUT <move>` / `END`. Response: header `OK`, STATE, DISPLAY,
   `STATUS <PLAYING|WIN|LOSS|DRAW|NO-WIN|ERROR>`, optional `RESULT`, `END`. Errors:
   well-formed ERROR frame + non-zero exit (`stop 1`), never garbage.
2. **`MOVE` with INPUT omitted = the engine plays the current side** (drives WOPR's own
   moves and self-play). `QUERY` re-emits without mutating.
3. **STATE is opaque** outside the game. Change its format freely BUT it must round-trip:
   `load_state(respond(x)) == x` semantics; bump nothing else — the host stores it verbatim.
4. **Deterministic**: same state+input ⇒ same output. Seed any randomness from state, never
   the clock. Tie-breaks must be explicit (e.g. lowest cell index).
5. **Period constructs only**: F77/F90 style — `do`/`dolist`-free plain loops, `character`
   buffers, internal procedures. No modern libs for game logic. Memory budget noted in the
   manifest.
6. **Golden discipline**: after intentional behavior changes, regenerate fixtures
   (`binary < NN.in > NN.out`) and **review the diff line by line** — goldens are the spec.
   Fixtures with `error` in the name must exit non-zero.

## Adding a game

`games/<id>/main.f90` (self-contained program — copy tictactoe as template) +
`harness/manifest.json` (`id`, `title`, `status:"implemented"`, `binary`, `abbrev`, `players`,
`summary`, `input_syntax`, optional `timeout_s` ≤10, `memory_budget_kb`) + `harness/tests/`
golden pairs. Nothing else changes: the build picks up `games/*/main.f90`, the host catalog
reads the manifest. A game never declares which inputs are its moves — the host is a
connection monitor, so once the terminal is attached to your game every non-reserved line
arrives at it, whatever the grammar. `abbrev` is the short tag shown in the prompt while you
hold the terminal (`[TTT]>`).

## Gotchas

- gfortran prints `STOP 1` to stderr on error exits — harmless, runners discard stderr.
- `character(len=N)` compares are padded; always `trim(...)` before `==`.
- The GTW clock only advances once war starts; setup (side selection) doesn't tick.
- DISPLAY lines for the Big Board are machine-parsed (`TRK`/`HIT` in gtw): format changes
  there must update `emulator/node/app/gtwfeed.py` + its tests + `emulator/web/norad-bigboard`.
