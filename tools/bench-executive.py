#!/usr/bin/env python3
"""What does the W.O.P.R. executive cost on every terminal turn?

The executive is on the hot path in a way no other program in the pack is: a
game spawns when you are playing one, but the executive spawns for every line
anybody types. The design spec (real-wopr, 2026-07-25-wopr-executive-design.md,
"Risks and accepted changes") requires that cost measured against a SKELETON
`wopr/main.f90` at the start of phase 2, before any logic goes into it, because
a spawn cost discovered after the whole executive exists is discovered too late.

This is that measurement, kept in the tree so it can be re-run. It measures
three things through the real harness classes, not a mock of them:

  A  a bridge turn         Router.handle("STATUS") — the cheapest turn there
                           is. Before the executive landed this cost nothing
                           at all: it was decided in Python with no
                           subprocess. It is now one executive spawn.
  B  a game turn           Router.handle("<move>") on tictactoe — the most
                           expensive ordinary turn there is. Two core spawns
                           (the human's move, then W.O.P.R.'s own reply) and
                           three executive spawns: the one that asks for the
                           first move, the one that is resumed with it and asks
                           for the second, and the one that prints the answer.
  C  one executive spawn   SystemRunner.run("wopr", ...) against the built
                           wopr binary, carrying the frame the executive
                           really receives: STATE, INPUT, and a full FACTS
                           block (spec E7 sends the facts every turn).
  D  one console spawn     SystemRunner.run("norad", ...) against the built
                           norad binary, carrying its own FACTS. Phase 3 of
                           the same spec makes NORAD operations a program of
                           its own, so every line an operator types is now
                           TWO spawns: the executive, which hands it to the
                           console, and the console. A console turn projects
                           to C + D against the same 15 ms gate phase 2 was
                           held to.

Run before the executive existed, A and B were the baseline and the projection
was A+C and B+C. Run after, A and B are the real thing and C is the isolated
cost of the piece that was added — so the same tool answers "what will this
cost" and "what did it cost", and the two can be compared.

    tools/bench-executive.py [iterations]     # default 300

Requires: `make build` (or at least wopr/harness/build.sh,
norad/harness/build.sh and the games), and the node host importable — `pip install -e "emulator/node[dev]"`.
"""
from __future__ import annotations

import asyncio
import statistics
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "emulator" / "node"))

from app.games import load_catalog                              # noqa: E402
from app.joshua import ScriptedJoshua                           # noqa: E402
from app.router import Router                                   # noqa: E402
from app.runner import CoreRunner, RunnerConfig                 # noqa: E402
from app.store import MemoryStore                               # noqa: E402
from app.systemrunner import SystemRunner, SystemRunnerConfig    # noqa: E402
from app.systems import System                                  # noqa: E402

N = int(sys.argv[1]) if len(sys.argv) > 1 else 300
WARM = 20

# A representative FACTS block: the whole catalog in recitation order, the
# stored game row, and the four session facts. This is what rides in on every
# turn, so it is what the measurement pays for.
FACTS_LINES = [
    "SURFACE home-terminal",
    "ROOM -",
    "DEFCON 5",
    "CLEARANCE 5",
    "GAMEROW tictactoe PLAYING 4 core",
    "GAME falkens-maze PLACEHOLDER RECITED FALKEN'S MAZE",
    "GAME blackjack IMPLEMENTED RECITED BLACK JACK",
    "GAME gin-rummy IMPLEMENTED RECITED GIN RUMMY",
    "GAME hearts IMPLEMENTED RECITED HEARTS",
    "SELFRES hearts",
    "GAME bridge PLACEHOLDER RECITED BRIDGE",
    "GAME checkers IMPLEMENTED RECITED CHECKERS",
    "GAME chess PLACEHOLDER RECITED CHESS",
    "GAME poker IMPLEMENTED RECITED POKER",
    "GAME fighter-combat PLACEHOLDER RECITED FIGHTER COMBAT",
    "GAME guerrilla PLACEHOLDER RECITED GUERRILLA ENGAGEMENT",
    "GAME desert-warfare PLACEHOLDER RECITED DESERT WARFARE",
    "GAME air-to-ground PLACEHOLDER RECITED AIR-TO-GROUND ACTIONS",
    "GAME theater-tactical PLACEHOLDER RECITED THEATERWIDE TACTICAL WARFARE",
    "GAME theater-biotoxic PLACEHOLDER RECITED THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE",
    "GAME tictactoe IMPLEMENTED UNLISTED TIC-TAC-TOE",
    "ABBREV tictactoe TTT",
    "SYNTAX tictactoe 0|1|2 players, X|O, cell 1-9, observe, yes|no",
    "INTERP tictactoe core core",
    "INTERP tictactoe heuristic daniel",
    "GAME gtw IMPLEMENTED TRAILING GLOBAL THERMONUCLEAR WAR",
    "ABBREV gtw GTW",
]
FACTS = "\n".join(FACTS_LINES)
STATE = "\n".join(["MODE JOSHUA - - BACKDOOR", "PARENT JOSHUA", "BACKDOOR 1",
                   "PENDING -", "FAILURES 0", "TURNS 7", "PHASE -",
                   "PA1 -", "PA2 -"])

# What the console cannot know for itself: who is logged on, the clearance
# floor, DEFCON, the conference, the link, and the room's game row.
CONSOLE_FACTS_LINES = [
    "CALLSIGN NORAD-3",
    "CLEARANCE 3",
    "DEFCON 5",
    "ROOM ALPHA",
    "LINK leased-9600",
    "GAMEROW gtw PLAYING 4 core",
]
CONSOLE_FACTS = "\n".join(CONSOLE_FACTS_LINES)

# The gate. A turn that projects above this is a reason to stop and change the
# approach (a persistent process), not a number to note and move past.
GATE_MS = 15.0


def stats(samples: list[float]) -> str:
    s = sorted(samples)
    p95 = s[min(len(s) - 1, int(len(s) * 0.95))]
    return (f"mean {statistics.mean(s) * 1000:6.2f} ms   "
            f"p50 {s[len(s) // 2] * 1000:6.2f} ms   "
            f"p95 {p95 * 1000:6.2f} ms   n={len(s)}")


async def main() -> int:
    binary = REPO / "wopr" / "harness" / "bin" / "wopr"
    if not binary.exists():
        print(f"no executive binary at {binary} — run wopr/harness/build.sh", file=sys.stderr)
        return 2
    console = REPO / "norad" / "harness" / "bin" / "norad"
    if not console.exists():
        print(f"no console binary at {console} — run norad/harness/build.sh", file=sys.stderr)
        return 2

    store = MemoryStore()
    catalog = load_catalog(REPO / "games")
    runner = CoreRunner(RunnerConfig(bin_dir=REPO / "games"))
    joshua = ScriptedJoshua({g.id: g.title for g in catalog.values()
                             if g.status == "implemented"})
    router = Router(runner, store, {"scripted": joshua}, catalog)

    session = await store.create_session("home-terminal", "modem-1200", None)
    sid = session.id
    await router.open_backdoor(sid)

    # A — a turn the bridge answers by itself.
    for _ in range(WARM):
        await router.handle(sid, "STATUS")
    a: list[float] = []
    for _ in range(N):
        t = time.perf_counter()
        await router.handle(sid, "STATUS")
        a.append(time.perf_counter() - t)

    # B — a turn that spawns the core twice. Restart the game whenever it ends
    # so every sample is a real move rather than a refusal.
    b: list[float] = []
    moves = ["1", "2", "3", "4", "5", "6", "7", "8", "9"]
    i = 0
    await router.handle(sid, "NEW TICTACTOE")
    for k in range(N + WARM):
        if router.attachment(sid).mode != "game":
            await router.handle(sid, "NEW TICTACTOE")
            i = 0
        move = moves[i % len(moves)]
        i += 1
        t = time.perf_counter()
        await router.handle(sid, move)
        elapsed = time.perf_counter() - t
        if k >= WARM:
            b.append(elapsed)

    # C — one executive spawn, carrying FACTS.
    srun = SystemRunner(
        SystemRunnerConfig(systems_dir=REPO),
        systems={"wopr": System(id="wopr", title="W.O.P.R.", language="fortran",
                                binary="wopr", number="")},
    )
    from app import systemrunner as _sr
    _build = _sr.build_system_request

    def _with_facts(*args, **kwargs) -> str:
        # FACTS rides in the request the executive receives. Spliced in around
        # the real codec so the spawn mechanism itself is untouched, and so
        # this tool keeps measuring the true frame if the codec grows a FACTS
        # argument of its own later.
        frame = _build(*args, **kwargs)
        head = frame[: -len("END\n")]
        return f"{head}FACTS {len(FACTS_LINES)}\n{FACTS}\nEND\n"

    _sr.build_system_request = _with_facts
    try:
        for _ in range(WARM):
            await srun.run("wopr", "INPUT", STATE, "LIST GAMES")
        c: list[float] = []
        for _ in range(N):
            t = time.perf_counter()
            await srun.run("wopr", "INPUT", STATE, "LIST GAMES")
            c.append(time.perf_counter() - t)
    finally:
        _sr.build_system_request = _build

    # D — one console spawn, carrying the console's own FACTS. The codec has
    # grown a `facts` argument since C was first measured, so no splice.
    crun = SystemRunner(
        SystemRunnerConfig(systems_dir=REPO),
        systems={"norad": System(id="norad", title="NORAD OPERATIONS",
                                 language="fortran", binary="norad", number="")},
    )
    for _ in range(WARM):
        await crun.run("norad", "INPUT", None, "SITREP", facts=CONSOLE_FACTS)
    d: list[float] = []
    for _ in range(N):
        t = time.perf_counter()
        await crun.run("norad", "INPUT", None, "SITREP", facts=CONSOLE_FACTS)
        d.append(time.perf_counter() - t)

    print()
    print("A  a bridge turn      ", stats(a))
    print("B  a game turn        ", stats(b))
    print("C  one executive spawn", stats(c))
    print("D  one console spawn  ", stats(d))
    print()
    one = statistics.mean(c)
    print("one executive spawn is %5.2f ms; a bridge turn is one of them, and a"
          % (one * 1000))
    print("game turn is three — the line, W.O.P.R.'s own reply, and the answer.")
    console_turn = statistics.mean(c) + statistics.mean(d)
    print()
    print("projected console turn  C+D   mean %5.2f ms   (gate %4.1f ms)"
          % (console_turn * 1000, GATE_MS))
    if console_turn * 1000 > GATE_MS:
        print("OVER THE GATE: a console turn must not spawn per line at this cost")
        return 1
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
