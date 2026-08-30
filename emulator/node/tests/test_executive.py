"""The seam between the executive and its host.

`wopr/main.f90` owns the routing decisions; this module's `router.py` runs it
and executes what it asks for. Two things need holding down at that seam:

1. **The voice.** W.O.P.R.'s lines are string constants in the Fortran, and
   `router.py` keeps copies only so the Python suites have a vocabulary to
   assert against. A copy that drifts from the original is worse than no copy,
   so these tests read the source of truth and compare.

2. **The host-visible STATE header.** Everything else in the executive's STATE
   block is opaque; the header line is the one thing the host reads, and it is
   what decides whether a reconnecting terminal is re-greeted, whether an
   access code is redacted before it reaches the event log, and when a session
   becomes authenticated.
"""

from pathlib import Path
import subprocess

import pytest

from app import router as R

REPO = Path(__file__).resolve().parents[3]
SOURCE = (REPO / "wopr" / "main.f90").read_text()
EXEC = REPO / "wopr" / "harness" / "bin" / "wopr"

needs_executive = pytest.mark.skipif(
    not EXEC.exists(), reason="executive not built (run wopr/harness/build.sh)")


# Every line of W.O.P.R.'s voice that router.py still names, and the Fortran
# text that must still carry it. A multi-line constant is listed per line,
# because that is how the executive emits it — one DISPLAY line each.
VOICE = [
    *R.LOGON_REJECTION.split("\n"),
    R.BACKDOOR_GREETING,
    R.HELP_NOT_AVAILABLE,
    *R.HELP_GAMES_DEFINITION.split("\n"),
    R.CHESS_CODA,
    R.NOWIN_RESULT,
    *R.NOWIN_VERDICT.split("\n"),
    R.NOT_IMPLEMENTED,
    R.CORE_TIMEOUT_TEXT,
    R.CORE_BUSY_TEXT,
    R.ACCESS_CODE_PROMPT,
    *R.IMPROPER_REQUEST.split("\n"),
    R.NO_GAME_IN_PROGRESS,
]


@pytest.mark.parametrize("line", VOICE)
def test_the_executive_still_says_what_the_harness_claims_it_says(line):
    # Fortran doubles an apostrophe inside a single-quoted literal; the
    # HELP GAMES definition is the one line here that has one.
    assert (f"'{line}'" in SOURCE
            or f'"{line}"' in SOURCE
            or f"'{line}'".replace("'GAMES'", "''GAMES''") in SOURCE), line


def test_the_lockout_limit_is_the_same_number_on_both_sides():
    assert f"LOGON_LOCK_LIMIT = {R.LOGON_LOCK_LIMIT}" in SOURCE


def test_the_console_lines_are_the_hosts_and_are_not_in_the_executive():
    # Phase 3 moves the operator tier into a program of its own. Until then
    # the console is answered by the host, and duplicating its words into the
    # executive would make that move ambiguous.
    for line in (R.UNRECOGNIZED_DIRECTIVE, R.CHANGES_LOCKED_OUT):
        assert line not in SOURCE, line


# --- the STATE header ------------------------------------------------------

def run_executive(state: list[str], user_input: str | None = None,
                  facts: list[str] | None = None) -> str:
    frame = ["SYSTEM/1 wopr INPUT", f"STATE {len(state)}", *state]
    if user_input is not None:
        frame.append(f"INPUT {user_input}")
    facts = facts if facts is not None else ["SURFACE home-terminal"]
    frame += [f"FACTS {len(facts)}", *facts, "END"]
    return subprocess.run([str(EXEC)], input="\n".join(frame) + "\n",
                          capture_output=True, text=True).stdout


def header_of(output: str) -> str:
    return output.split("\n")[2]


@needs_executive
def test_a_session_with_no_state_yet_is_at_the_front_door():
    # The host never writes the executive's STATE block, so "no state" is how
    # a brand new session announces itself.
    assert header_of(run_executive([], "HELLO")).split() == [
        "MODE", "FRONT-DOOR", "-", "-", "-"]


@needs_executive
def test_the_header_says_when_the_backdoor_opened():
    assert header_of(run_executive([], "JOSHUA")).split()[4] == "BACKDOOR"


@needs_executive
def test_the_header_says_when_an_access_code_is_expected():
    # This flag is what makes the host log [REDACTED] instead of the code.
    out = run_executive([], "LOGON NORAD-3", ["SURFACE norad-terminal"])
    assert "CALL roster" in out          # the roster is asked, not FACTS
    reply = ["REPLY roster OK 1", "YES"]
    state = out.split("\n")[2:11]
    frame = ["SYSTEM/1 wopr INPUT", f"STATE {len(state)}", *state,
             "FACTS 1", "SURFACE norad-terminal", *reply, "END"]
    second = subprocess.run([str(EXEC)], input="\n".join(frame) + "\n",
                            capture_output=True, text=True).stdout
    assert "ACCESS CODE:" in second
    assert header_of(second).split()[3] == "PENDING"


@needs_executive
def test_the_header_names_the_attached_program():
    out = run_executive(
        ["MODE GAME tictactoe - BACKDOOR", "PARENT JOSHUA", "BACKDOOR 1",
         "PENDING -", "FAILURES 0", "TURNS 0", "PHASE -", "PA1 -", "PA2 -"],
        "STATUS", ["SURFACE home-terminal", "GAMEROW tictactoe PLAYING 2 core",
                   "GAME tictactoe IMPLEMENTED UNLISTED TIC-TAC-TOE",
                   "ABBREV tictactoe TTT"])
    assert header_of(out).split()[:3] == ["MODE", "GAME", "tictactoe"]
    # And the prompt the host hands the terminal carries the same fact, which
    # is the only form of it a 300-baud teletype can render.
    assert "PROMPT [TTT]>" in out


@needs_executive
def test_a_clearance_code_never_rides_in_the_facts_block():
    # The roster answers yes or no; the codes are never sent. A roster in
    # every frame would be a roster in every log, and an access code more so.
    out = run_executive([], "LOGON NORAD-3", ["SURFACE norad-terminal"])
    assert "CALL roster 1" in out
    assert "HAS NORAD-3" in out
    # The executive asks; it does not carry a roster of its own to check.
    assert "TIGERTEAM" not in SOURCE
