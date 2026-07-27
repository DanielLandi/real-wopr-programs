# devkit — the WOPR DEVELOPMENT SYSTEM

The "not in the movie" experience: a **period line-oriented development session** over the
real repo. It recreates the 1980s edit → compile → run → debug loop as a proxy to the actual
source — you edit the same `games/` and `joshua/` files, then build and run them
with the real toolchain. A contributor can work entirely through this session, or edit the
files directly in the repo; both touch the same bytes.

> **Local contributor tooling only.** This runs a shell and drops into a Lisp listener — it is
> never exposed as a network service (that would be remote code execution as a feature). It is
> not part of the deployed exchange.

## Run

```bash
cd emulator/devkit
python -m wopr_dev        # any python3 ≥3.11; sbcl needed for LISP/CHAT, gfortran for FORTRAN/RUN
```

```
WOPR.DEV> DIRECTORY core
WOPR.DEV> EDIT games/tictactoe/main.f90
*edit>    N                 # list with line numbers (SOS-style)
*edit>    S 42 /X/O/         # substitute on a line
*edit>    E                 # save + exit
WOPR.DEV> FORTRAN            # builds the programs (make build at the pack root)
WOPR.DEV> RUN tictactoe     # feeds a NEW frame to the real binary
WOPR.DEV> GOLDEN core       # the golden fixture suite (tools/test.sh games)
WOPR.DEV> LISP              # drops into a real SBCL listener, F.D.P. preloaded
WOPR.DEV> CHAT ARE YOU JOSHUA
```

Inside `LISP` you get a genuine `*` listener with the Falken Dialogue Processor loaded — the
authentic Lisp workflow: poke at functions, edit `src/*.lisp` in another pane, `(load ...)`
to reload, call `(joshua:respond (list) "...")`. `(quit)` returns to the monitor.

## Period grounding (honestly labeled, like the rest of the project)

The **interaction model** is faithful to how you actually developed on a DEC PDP-10 (TOPS-10)
or VAX in 1983: a line editor (**SOS**/EDT — no full-screen), then `.R FORTRAN`/`.EXECUTE`,
and for AI work an interactive Lisp listener. The editor commands here (P/N/I/A/R/D/S/W/E/Q)
mirror SOS line mode. What's **modern**: it's Python glue over `gfortran` and `SBCL` rather
than a real DEC monitor, and it edits UTF-8 files in a git repo. We reproduce the *workflow*,
not the instruction set — the same standard this project applies everywhere
(the engine repo's `docs/feasibility.md`). References: TOPS-10 SOS Reference Manual; PDP-10 FORTRAN IV
Programming Manual (bitsavers).

## Tests

```bash
# any python3 with pytest (CI uses the emulator/node venv: pip install -e "emulator/node[dev]")
python -m pytest tests/   # editor + dispatch; program-touching tests skip if unbuilt
```
