"""The seam between the executive and its host — and the console's.

`wopr/main.f90` owns the routing decisions; this module's `router.py` runs it
and executes what it asks for. `norad/main.f90` owns the operator console's
decisions the same way, and the same host runs it. Three things need holding
down at that seam:

1. **The voice.** W.O.P.R.'s lines are string constants in the Fortran, and
   `router.py` keeps copies only so the Python suites have a vocabulary to
   assert against. A copy that drifts from the original is worse than no copy,
   so these tests read the source of truth and compare.

2. **The host-visible STATE header.** Everything else in the executive's STATE
   block is opaque; the header line is the one thing the host reads, and it is
   what decides whether a reconnecting terminal is re-greeted, whether an
   access code is redacted before it reaches the event log, and when a session
   becomes authenticated.

3. **The radar table.** `gtwfeed.tracks_text` is the Python rendering the
   console's TRACKS readout was translated from. It is kept as the oracle:
   the built console, handed the same feed as cards, must print exactly what
   it prints.
"""

from pathlib import Path
import subprocess

import pytest

from app import router as R
from app.gtwfeed import display_to_feed, tracks_text

REPO = Path(__file__).resolve().parents[3]
SOURCE = (REPO / "wopr" / "main.f90").read_text()
EXEC = REPO / "wopr" / "harness" / "bin" / "wopr"
CONSOLE_SOURCE = (REPO / "norad" / "main.f90").read_text()
CONSOLE = REPO / "norad" / "harness" / "bin" / "norad"

needs_executive = pytest.mark.skipif(
    not EXEC.exists(), reason="executive not built (run wopr/harness/build.sh)")
needs_console = pytest.mark.skipif(
    not CONSOLE.exists(), reason="console not built (run norad/harness/build.sh)")


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


# The console's voice, the same way: `norad/main.f90` owns these, and the
# copies in router.py exist for the Python suites to assert against.
CONSOLE_VOICE = [
    R.UNRECOGNIZED_DIRECTIVE,
    R.CHANGES_LOCKED_OUT,
    R.CEASE_RANDOM_FUNCTION,
    R.CLEARANCE_DENIED,
    R.NO_ACTIVE_TRACKS,
    R.NO_EVENTS_LOGGED,
    # A failed radar call is said in the executive's words, from the same
    # failure shapes — so those lines live in both programs, verbatim.
    R.CORE_TIMEOUT_TEXT,
    R.CORE_BUSY_TEXT,
    *R.IMPROPER_REQUEST.split("\n"),
]


@pytest.mark.parametrize("line", CONSOLE_VOICE)
def test_the_console_still_says_what_the_harness_claims_it_says(line):
    assert f"'{line}'" in CONSOLE_SOURCE, line


def test_the_console_lines_are_the_consoles_and_are_not_in_the_executive():
    # The operator tier is a program of its own (phase 3). The executive
    # hands it the line and prints its answer; it does not know the words.
    for line in (R.UNRECOGNIZED_DIRECTIVE, R.CHANGES_LOCKED_OUT, R.CLEARANCE_DENIED):
        assert line not in SOURCE, line


def test_the_journal_limit_is_the_same_number_on_both_sides():
    assert f"JOURNAL_LINES = {R.JOURNAL_LIMIT}" in CONSOLE_SOURCE


# --- the radar table --------------------------------------------------------

def run_console(state: list[str], user_input: str | None = None,
                facts: list[str] | None = None, reply: list[str] | None = None) -> str:
    frame = ["SYSTEM/1 norad INPUT", f"STATE {len(state)}", *state]
    if user_input is not None:
        frame.append(f"INPUT {user_input}")
    facts = facts if facts is not None else ["CALLSIGN NORAD-3", "CLEARANCE 3"]
    frame += [f"FACTS {len(facts)}", *facts]
    if reply is not None:
        frame += reply
    frame.append("END")
    return subprocess.run([str(CONSOLE)], input="\n".join(frame) + "\n",
                          capture_output=True, text=True).stdout


def display_of(output: str) -> str:
    lines = output.split("\n")
    for i, line in enumerate(lines):
        if line.startswith("DISPLAY "):
            n = int(line.split()[1])
            return "\n".join(lines[i + 1:i + 1 + n])
    raise AssertionError(f"no DISPLAY block in {output!r}")


RADAR_DISPLAYS = [
    "ZULU --:--  DEFCON 5\n",
    ("ZULU 00:30  DEFCON 2\n"
     "UNITED STATES  ARSENAL 20  CITIES LOST 0\n"
     "SOVIET UNION   ARSENAL 19  CITIES LOST 1\n"
     "TRK WASHINGTON MOSCOW -77 39 37 56 0.40\n"
     "HIT LENINGRAD\n"),
    # E12's picture: DEFCON 2 puts aircraft and ships up, two missiles fly,
    # and the clock's minutes set every track's progress.
    ("ZULU 00:06  DEFCON 2\n"
     "TRK NOVOSIBIRSK LASVEGAS 83 55 -115 36 0.20\n"
     "TRK NEWYORK LENINGRAD -74 41 30 60 0.10\n"),
    # More events than the readout shows, and a city hit twice.
    ("ZULU 00:45  DEFCON 1\n"
     "TRK MOSCOW WASHINGTON 37 56 -77 39 0.95\n"
     "HIT LENINGRAD\nHIT LENINGRAD\nHIT SEATTLE\n"
     "EXCHANGE COMPLETE\nWINNER: NONE\nESTIMATED CASUALTIES 120 MILLION\n"),
]


@needs_console
@pytest.mark.parametrize("display", RADAR_DISPLAYS)
def test_the_console_prints_the_radar_table_the_python_printed(display):
    feed = display_to_feed(display, "PLAYING")
    cards = R._feed_cards(feed)
    out = run_console(["PHASE RADAR", "PA1 -"],
                      facts=["CALLSIGN NORAD-3", "CLEARANCE 3", "GAMEROW gtw PLAYING 4 core"],
                      reply=[f"REPLY radar OK {len(cards)}", *cards])
    assert display_of(out) == tracks_text(feed)


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


# --- when the machine cannot reach its own executive ------------------------

def test_a_saturated_pool_is_answered_in_character_not_by_a_dead_socket():
    """A busy or slow executive is transient and was always said in character.

    Before phase 2 a saturated core pool printed ALL WOPR PROCESSORS
    COMMITTED and the line stayed up. The executive being on every turn must
    not turn that into a dropped session — only a *missing* or unparseable
    executive is a deployment fault worth failing loudly on.
    """
    import asyncio

    from app.games import load_catalog
    from app.joshua import ScriptedJoshua
    from app.router import ExecutiveUnavailable, Router
    from app.runner import CoreRunner, RunnerConfig
    from app.store import MemoryStore
    from app.systemrunner import SystemBusy, SystemFault, SystemTimeout

    async def turn_with(failure: Exception):
        store = MemoryStore()
        catalog = load_catalog(REPO / "games")
        runner = CoreRunner(RunnerConfig(bin_dir=REPO / "games"))
        joshua = ScriptedJoshua({g.id: g.title for g in catalog.values()
                                 if g.status == "implemented"})
        router = Router(runner, store, {"scripted": joshua}, catalog)
        session = await store.create_session("home-terminal", "dialup-300", None)

        async def refuse(*args, **kwargs):
            raise failure

        router._exec.run = refuse
        return await router.handle(session.id, "HELLO")

    busy = asyncio.run(turn_with(SystemBusy("pool full")))
    assert busy.text == R.CORE_BUSY_TEXT
    assert busy.prompt == ">"

    slow = asyncio.run(turn_with(SystemTimeout("no answer")))
    assert slow.text == R.CORE_TIMEOUT_TEXT

    # A missing binary is not transient and must not be dressed up as one.
    try:
        asyncio.run(turn_with(SystemFault(None, "no binary for system 'wopr'")))
    except ExecutiveUnavailable:
        pass
    else:                                        # pragma: no cover
        raise AssertionError("a missing executive must fail loudly")


@needs_executive
def test_a_new_line_abandons_a_continuation_that_never_got_its_answer():
    # Pinned byte-exact by wopr/harness/tests/15-*, and here because the
    # consequence is the one that matters: the NEXT turn's reply must not be
    # resumed into a stale phase.
    out = run_executive(
        ["MODE GAME tictactoe - BACKDOOR", "PARENT JOSHUA", "BACKDOOR 1",
         "PENDING -", "FAILURES 0", "TURNS 3", "PHASE MOVE2", "PA1 tictactoe",
         "PA2 -", "HOLD 1", " X | . | ."],
        "STATUS", ["SURFACE home-terminal", "GAMEROW tictactoe PLAYING 4 core"])
    assert "PHASE -" in out
    assert "HOLD" not in out
    assert "SIMULATION: TICTACTOE TURN 4" in out
