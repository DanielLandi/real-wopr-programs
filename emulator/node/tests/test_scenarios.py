"""The ending-montage scenario names — now the executive's, not the bridge's.

The sweep used to be `app/scenarios.py`, a Python tuple the router appended to
a NO-WIN GTW turn. It is W.O.P.R.'s own voice, so it moved into `wopr/main.f90`
as a DATA table (`wopr/scenarios.inc`), which is how 1983 carried a table like
this. These tests drive the built executive and read the sweep off the wire, so
what they pin is what the machine actually prints — not a second copy of it.

The names are facts shown on screen, reproduced in screen order from the abs0
`wargames` recreation's table. Spellings are the source's, verbatim: the
on-screen list has its own oddities and we do not silently correct them,
exactly as with the router's INDENTIFICATION (fidelity audit 2026-08-03,
real-wopr#161).
"""

from pathlib import Path
import subprocess

import pytest

REPO = Path(__file__).resolve().parents[3]
EXEC = REPO / "wopr" / "harness" / "bin" / "wopr"

needs_executive = pytest.mark.skipif(
    not EXEC.exists(), reason="executive not built (run wopr/harness/build.sh)")


def montage_lines() -> list[str]:
    """The DISPLAY the executive prints when a live GTW exchange ends NO-WIN.

    Fed as a canned REPLY, which is exactly how a golden fixture drives it:
    the executive asked its host for GTW's move and is being resumed with the
    answer.
    """
    reply = ["MOVED", "STATUS NO-WIN",
             "RESULT A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.",
             "DISPLAY 1", "EXCHANGE COMPLETE"]
    state = ["MODE GAME gtw - BACKDOOR", "PARENT JOSHUA", "BACKDOOR 1",
             "PENDING -", "FAILURES 0", "TURNS 3", "PHASE MOVE2",
             "PA1 gtw", "PA2 -"]
    frame = ["SYSTEM/1 wopr INPUT", f"STATE {len(state)}", *state,
             "FACTS 1", "SURFACE home-terminal",
             f"REPLY gtw OK {len(reply)}", *reply, "END"]
    out = subprocess.run([str(EXEC)], input="\n".join(frame) + "\n",
                         capture_output=True, text=True, check=True).stdout
    lines = out.split("\n")
    start = next(i for i, ln in enumerate(lines) if ln.startswith("DISPLAY ")) + 1
    count = int(lines[start - 1].split()[1])
    return lines[start:start + count]


@pytest.fixture(scope="module")
def sweep() -> list[str]:
    lines = montage_lines()
    first = lines.index("RUNNING ALL STRATEGIES...") + 2
    last = lines.index("*** ALL SCENARIOS EXHAUSTED ***") - 1
    return lines[first:last]


@needs_executive
def test_the_sweep_is_the_whole_on_screen_table(sweep):
    # Pinned downstream (real-wopr evals/scenarios/e04, tests/test_gtw.py).
    assert len(sweep) == 157
    assert sweep[0] == "U.S. FIRST STRIKE"
    assert sweep[-1] == "CASPIAN DEFENCE"


@needs_executive
def test_the_screens_own_misspellings_survive_the_move(sweep):
    for odd in ("AUSTRAILIAN MANEUVER", "PALISTANIAN LOCAL", "ROMAINIAN WAR",
                "ISREAL DISCRETIONARY", "PACT MEDIAN", "BURMESE THEATERWIOE"):
        assert odd in sweep, odd
    # CHAD ALERT genuinely appears twice in the sweep; the repeat is kept.
    assert sweep.count("CHAD ALERT") == 2


@needs_executive
def test_the_montage_prints_every_scenario_between_its_banners(sweep):
    lines = montage_lines()
    assert "RUNNING ALL STRATEGIES..." in lines
    assert "*** ALL SCENARIOS EXHAUSTED ***" in lines
    assert lines[-1] == "HOW ABOUT A NICE GAME OF CHESS?"
    # The verdict, in the film's three-line break, after the sweep.
    assert "A STRANGE GAME." in lines
    assert "THE ONLY WINNING MOVE IS" in lines
    assert "NOT TO PLAY." in lines
    assert len(sweep) == 157
