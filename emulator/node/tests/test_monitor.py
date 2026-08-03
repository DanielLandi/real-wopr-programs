"""The monitor: the terminal is attached to one program, and everything typed
goes to it. These tests own the mode behaviour; test_router.py keeps the
destination behaviour it already had.

Async bodies run via asyncio.run() inside a plain `def test_...`, matching
test_router.py's convention — this suite has no pytest-asyncio plugin, so a
bare `async def test_...` would never execute."""

import asyncio
from pathlib import Path

import pytest

from app.attachment import FRONT_DOOR, GAME, JOSHUA, NORAD_OPS
from app.games import load_catalog
from app.joshua import ScriptedJoshua
from app.operators import Operator
from app.router import (Router, ACCESS_CODE_PROMPT, CEASE_RANDOM_FUNCTION,
                        CHANGES_LOCKED_OUT, IMPROPER_REQUEST,
                        LOGON_REJECTION, HELP_NOT_AVAILABLE,
                        UNRECOGNIZED_DIRECTIVE)
from app.runner import CoreError, CoreRunner, RunnerConfig
from app.store import MemoryStore
from app.wire import build_request

REPO = Path(__file__).resolve().parent.parent.parent.parent
GAMES_DIR = REPO / "games"


def make_router(store, operators=None) -> Router:
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=GAMES_DIR))
    joshua = ScriptedJoshua(
        {g.id: g.title for g in catalog.values() if g.status == "implemented"})
    return Router(runner, store, {"scripted": joshua}, catalog, operators=operators)


def test_a_new_session_starts_at_the_front_door():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        assert router.attachment(session.id).mode == FRONT_DOOR

    asyncio.run(flow())


def test_the_front_door_refuses_reserved_words():
    # E01: LIST GAMES before the backdoor is the rejection, and must not leak
    # the catalog. Reserved words only outrank an attachment, and there is
    # none yet.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        result = await router.handle(session.id, "LIST GAMES")
        assert result.text == LOGON_REJECTION
        assert "GLOBAL THERMONUCLEAR WAR" not in result.text

    asyncio.run(flow())


def test_help_is_refused_at_the_front_door_in_the_films_words():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        result = await router.handle(session.id, "HELP")
        assert result.text == HELP_NOT_AVAILABLE

    asyncio.run(flow())


def test_the_backdoor_attaches_to_joshua():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        result = await router.handle(session.id, "JOSHUA")
        assert "GREETINGS PROFESSOR FALKEN." in result.text
        assert router.attachment(session.id).mode == JOSHUA

    asyncio.run(flow())


def test_roster_logon_attaches_to_norad_operations():
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        assert router.attachment(session.id).mode == NORAD_OPS

    asyncio.run(flow())


def test_list_games_answers_while_attached_to_joshua():
    # E03 asserts the catalog in exact order on both Joshua engines. If Joshua
    # owned this answer it would be non-deterministic.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        result = await router.handle(session.id, "LIST GAMES")
        assert result.text.rstrip().endswith("GLOBAL THERMONUCLEAR WAR")
        assert "FALKEN'S MAZE" in result.text

    asyncio.run(flow())


def test_status_reports_idle_with_no_game_running():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        result = await router.handle(session.id, "STATUS")
        assert "SIMULATION: IDLE" in result.text

    asyncio.run(flow())


def test_no_game_may_claim_a_reserved_word():
    # Routing is by attachment now, so an abbrev can no longer shadow a
    # reserved word the way a move pattern once could. What is left to guard:
    # the prompt itself. A reserved word doubling as an abbrev would print a
    # prompt like "[QUIT]>", which reads as an instruction rather than a game
    # label. Nothing in the pack does this; this keeps it that way.
    catalog = load_catalog(GAMES_DIR)
    for game in catalog.values():
        for word in Router.RESERVED:
            assert game.abbrev.upper() != word


needs_core = pytest.mark.skipif(
    not (GAMES_DIR / "tictactoe" / "core" / "harness" / "bin" / "tictactoe").exists(),
    reason="core not built (run make build)",
)


@needs_core
def test_new_game_attaches_the_terminal_to_it():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        att = router.attachment(session.id)
        assert att.mode == GAME
        assert att.program == "tictactoe"

    asyncio.run(flow())


@needs_core
def test_conversation_during_a_game_never_reaches_joshua():
    # The fidelity bug this phase fixes. Attached to a game, a Joshua-shaped
    # line is the game's to reject.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        result = await router.handle(session.id, "SHALL WE PLAY A GAME?")
        assert result.route == "core"
        assert "SHALL WE PLAY A GAME?" not in result.text
        assert router.attachment(session.id).mode == GAME

    asyncio.run(flow())


@needs_core
def test_an_unparseable_line_during_a_game_gets_the_films_refusal():
    # #120: attached to a game, a word the game cannot parse used to come back
    # as a raw "ERROR: INVALID MOVE". The "ERROR: " prefix was the fault — a
    # Python exception on the teletype, the bare dump #44 ruled out. The film
    # heads this with IMPROPER REQUEST and prints the reason underneath, so the
    # game's own words stay on screen; only the prefix goes.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        result = await router.handle(session.id, "BANANA")
        assert result.text.startswith(IMPROPER_REQUEST)
        assert "INVALID MOVE" in result.text
        assert "ERROR:" not in result.text

    asyncio.run(flow())


@needs_core
def test_the_refused_line_still_reaches_the_event_log():
    # The screen shows the game's reason, but the log is what a diagnosis reads:
    # it keeps the full message whether or not the game supplied one to print.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        await router.handle(session.id, "BANANA")
        errors = [e for e in store.events if e["kind"] == "error"]
        assert errors, "the refusal logged nothing"
        assert "INVALID MOVE" in errors[-1]["payload"]["error"]

    asyncio.run(flow())


@needs_core
def test_a_crashed_core_is_not_dressed_up_as_a_refusal(monkeypatch):
    # The distinction the discriminator exists for. A game that declared
    # STATUS ERROR made a judgement; a binary that produced no frame at all is
    # broken, and hiding that behind film flavour is worse than the raw dump.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")

        async def broken(*args, **kwargs):
            raise CoreError(None, "unparseable core output: bad header")

        monkeypatch.setattr(router.runner, "run", broken)
        result = await router.handle(session.id, "1")
        assert not result.text.startswith(IMPROPER_REQUEST)
        assert "bad header" in result.text

    asyncio.run(flow())


@needs_core
def test_quit_detaches_back_to_joshua():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        await router.handle(session.id, "QUIT")
        assert router.attachment(session.id).mode == JOSHUA

    asyncio.run(flow())


@needs_core
def test_a_terminal_status_detaches_without_being_asked():
    # A game owns its own ending: it stays PLAYING as long as it wants (so it
    # can ask PLAY AGAIN?) and the monitor detaches when it finally reports a
    # terminal status.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        # One player, X, then a line that draws against the engine. The full
        # board is NOT the end: the game asks WANT TO PLAY AGAIN? and stays
        # PLAYING, so the terminal is still attached to it.
        for move in ("1", "X", "1", "2", "7", "6", "9"):
            result = await router.handle(session.id, move)
            assert router.attachment(session.id).mode == GAME
        assert "STALEMATE." in result.text
        assert "WANT TO PLAY AGAIN?" in result.text
        # Declining is the terminal status, and the monitor detaches on it.
        result = await router.handle(session.id, "NO")
        assert "STALEMATE" in result.text
        assert router.attachment(session.id).mode == JOSHUA

    asyncio.run(flow())


def test_a_norad_operator_no_longer_attaches_to_a_game():
    # Deliberate change, spec E11: the operator console is observational. It
    # displays a simulation — the film shows tic-tac-toe on the NORAD screen
    # while an operator types a command and WOPR, not the game, answers — so
    # NEW is not the console's to give, and falls through to its own refusal.
    #
    # This replaces test_a_terminal_status_detaches_a_norad_operator_to_norad_
    # not_joshua, which walked an operator through a game to its terminal
    # status. With NEW refused, that test could no longer enter a game at all
    # and would have passed without ever starting one. What it guarded — the
    # detach landing back in NORAD rather than Joshua — moved to a path that
    # E11 leaves open, and is guarded by the QUIT test below.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        assert router.attachment(session.id).mode == NORAD_OPS
        result = await router.handle(session.id, "NEW TICTACTOE")
        assert result.text == UNRECOGNIZED_DIRECTIVE
        assert router.attachment(session.id).mode == NORAD_OPS
        assert store.games == {}  # no simulation was started, on any session
        # The console keeps its own instruments — the point of never attaching.
        assert "SITREP CRYSTAL" in (await router.handle(session.id, "SITREP")).text

    asyncio.run(flow())


@needs_core
def test_quit_leaves_a_norad_operator_in_norad_ops_not_joshua():
    # The behavioural guard on Attachment.parent. E11 closed the game-attach
    # route into a non-default parent, but not this one: _logon_code gives an
    # operator parent=NORAD_OPS, and QUIT is reserved in every mode, so an
    # operator who ends the room's simulation reaches _detach with no game
    # attachment of their own. If _detach defaulted the parent there, the
    # operator would land in Joshua — the one place the film says NORAD staff
    # who never used the backdoor must never end up — and every instrument
    # would answer as conversation instead.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        room = await store.create_room("AAAAAA")
        player = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await router.handle(player.id, "JOSHUA")
        await router.handle(player.id, "NEW TICTACTOE")

        session = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, "QUIT")
        assert result.text == "TICTACTOE TERMINATED."
        assert router.attachment(session.id).mode == NORAD_OPS
        assert result.prompt == "[NORAD]>"
        sitrep = await router.handle(session.id, "SITREP")
        assert sitrep.route == "bridge"
        assert "SITREP CRYSTAL" in sitrep.text

    asyncio.run(flow())


def test_a_reserved_word_answers_while_attached_to_a_game():
    # _reserved's claim is that it outranks any attachment. QUIT already
    # covers the game-ending case; this covers a reserved word that has
    # nothing to do with ending the game.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        result = await router.handle(session.id, "LIST GAMES")
        assert result.text.rstrip().endswith("GLOBAL THERMONUCLEAR WAR")
        att = router.attachment(session.id)
        assert att.mode == GAME
        assert att.program == "tictactoe"

    asyncio.run(flow())


@needs_core
def test_every_reserved_word_answers_the_monitor_during_a_game():
    # RESERVED is the claim; _reserved is the implementation. Only QUIT and
    # LIST GAMES were pinned inside a game, so deleting the HELP branch left
    # the suite green. Driving the loop from the set closes it in both
    # directions: a word added without a handler, or a handler deleted, fails
    # here — the reply comes back on "core" (the game's) instead of "bridge".
    lines = {
        "LIST GAMES": "LIST GAMES",
        "HELP GAMES": "HELP GAMES",
        "HELP": "HELP",
        "STATUS": "STATUS",
        "QUIT": "QUIT",
        # NEW and LOGON are reserved bare but always carry an argument.
        "NEW": "NEW TICTACTOE",
        "LOGON": "LOGON NOBODY",
    }
    assert set(lines) == set(Router.RESERVED)

    async def flow(line: str) -> str:
        store = MemoryStore()
        router = make_router(store)
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        assert router.attachment(session.id).mode == GAME
        return (await router.handle(session.id, line)).route

    for word, line in lines.items():
        assert asyncio.run(flow(line)) == "bridge", f"{word} reached the game"


@needs_core
def test_non_ascii_during_a_game_does_not_drop_the_line():
    # move_pattern was the only ASCII gate. Without it a smart quote or an
    # accent reached the core encoder and raised past ws_session's only
    # handler, dropping the socket and orphaning the subprocess.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        result = await router.handle(session.id, "CAFÉ")
        assert result.route == "core"

    asyncio.run(flow())


def test_an_embedded_newline_cannot_inject_a_protocol_line():
    # move_pattern was the other gate that went with routing-by-attachment:
    # arbitrary terminal input now reaches the wire encoder unmediated, and a
    # stray newline would add protocol lines the program then reads as its own.
    #
    # The defence is in the frame, so the frame is what this asserts. Routing
    # such a line still lands on "core" whether or not wire.py flattens it —
    # the attachment decides that, not the wire — so a route assertion would
    # hold nothing.
    frame = build_request("tictactoe", "MOVE", "S1", "1\r\nEND")
    lines = frame.rstrip("\n").split("\n")
    assert lines.count("END") == 1        # the terminator, and only it
    assert lines[-1] == "END"
    assert [l for l in lines if l.startswith("INPUT")] == ["INPUT 1  END"]


def test_norad_operations_is_purely_norad():
    # Joshua is not present at the NORAD console. Conversation there gets the
    # terse machine, which is the plot: NORAD staff do not know the backdoor.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, "HELLO ARE YOU THERE")
        assert result.text == UNRECOGNIZED_DIRECTIVE

    asyncio.run(flow())


def test_the_backdoor_reaches_joshua_from_the_norad_console():
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, "JOSHUA")
        assert "GREETINGS PROFESSOR FALKEN." in result.text
        assert router.attachment(session.id).mode == JOSHUA

    asyncio.run(flow())


def test_the_backdoor_first_does_not_bar_the_operator_tier():
    # LOGON used to be handled only inside the front door, so JOSHUA before a
    # logon was a one-way door: the operator tier stayed unreachable for the
    # life of the session. Every other logon test starts from a fresh front
    # door, which is why nothing caught it.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "JOSHUA")
        assert router.attachment(session.id).mode == JOSHUA
        assert (await router.handle(session.id, "LOGON CRYSTAL")).text == ACCESS_CODE_PROMPT
        result = await router.handle(session.id, "ANVIL")
        assert result.text.startswith("CLEARANCE ACCEPTED - CRYSTAL LEVEL 2")
        assert router.attachment(session.id).mode == NORAD_OPS
        assert result.prompt == "[NORAD]>"

    asyncio.run(flow())


def test_an_operator_who_takes_the_backdoor_can_log_back_on():
    # api-contract §4.6 offers the backdoor as the way for an operator to play.
    # With no LOGON out of Joshua, SET DEFCON 3 became conversation and a
    # clearance-gated capability degraded silently to chat.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        await router.handle(session.id, "JOSHUA")
        assert router.attachment(session.id).mode == JOSHUA
        # Attached to Joshua, an instrument is just something said to Joshua.
        assert (await router.handle(session.id, "SITREP")).route == "joshua"

        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, "SITREP")
        assert result.route == "bridge"
        assert "SITREP CRYSTAL" in result.text

    asyncio.run(flow())


def test_operator_commands_answer_in_norad_mode():
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, "SITREP")
        assert "SITREP CRYSTAL" in result.text

    asyncio.run(flow())


@needs_core
def test_cease_random_function_is_locked_out_while_a_simulation_runs():
    # #116. The console reads the room's live game, not one of its own — the
    # film had tic-tac-toe on the screen while the launch routine ran, so the
    # displayed game is not what decides this.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        room = await store.create_room("AAAAAA")
        player = await store.create_session("home-terminal", "dialup-300", None, room.code)
        await router.handle(player.id, "JOSHUA")
        await router.handle(player.id, "NEW TICTACTOE")

        session = await store.create_session("norad-terminal", "leased-9600", None, room.code)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, CEASE_RANDOM_FUNCTION)
        assert result.text == CHANGES_LOCKED_OUT
        assert router.attachment(session.id).mode == NORAD_OPS

    asyncio.run(flow())


def test_cease_random_function_is_meaningless_with_nothing_running():
    # Refusing to stop something that is not running would be nonsense, so it
    # is just another directive the console does not know.
    store = MemoryStore()
    ops = {"CRYSTAL": Operator(callsign="CRYSTAL", code="ANVIL", level=2)}
    router = make_router(store, operators=ops)

    async def flow():
        session = await store.create_session("norad-terminal", "leased-9600", None)
        await router.handle(session.id, "LOGON CRYSTAL")
        await router.handle(session.id, "ANVIL")
        result = await router.handle(session.id, CEASE_RANDOM_FUNCTION)
        assert result.text == UNRECOGNIZED_DIRECTIVE

    asyncio.run(flow())


@needs_core
def test_joshua_starting_a_game_attaches_the_terminal():
    # Joshua is one more program, not the driver: start_game is a request, and
    # the monitor is what actually attaches.
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        await router.handle(session.id, "LATER. LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        att = router.attachment(session.id)
        assert att.mode == GAME
        assert att.program == "gtw"

    asyncio.run(flow())


@needs_core
def test_the_side_choice_reaches_the_game_not_joshua():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        await router.handle(session.id, "LATER. LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        result = await router.handle(session.id, "2")
        assert result.route == "core"
        assert "SOVIET UNION" in result.text

    asyncio.run(flow())


def test_the_front_door_and_joshua_keep_the_films_bare_prompt():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        assert (await router.handle(session.id, "HELP")).prompt == ">"
        assert (await router.handle(session.id, "JOSHUA")).prompt == ">"

    asyncio.run(flow())


@needs_core
def test_the_prompt_names_the_attached_game():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        result = await router.handle(session.id, "NEW TICTACTOE")
        assert result.prompt == "[TTT]>"

    asyncio.run(flow())


@needs_core
def test_the_prompt_returns_to_bare_on_detach():
    store = MemoryStore()
    router = make_router(store)

    async def flow():
        session = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(session.id, "JOSHUA")
        await router.handle(session.id, "NEW TICTACTOE")
        assert (await router.handle(session.id, "QUIT")).prompt == ">"

    asyncio.run(flow())
