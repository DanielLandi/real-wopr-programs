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
from app.router import Router, LOGON_REJECTION, HELP_NOT_AVAILABLE
from app.runner import CoreRunner, RunnerConfig
from app.store import MemoryStore

REPO = Path(__file__).resolve().parent.parent.parent.parent
GAMES_DIR = REPO / "games"


def make_router(store, operators=None) -> Router:
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=GAMES_DIR))
    joshua = ScriptedJoshua(
        {g.id: g.title for g in catalog.values() if g.status == "implemented"})
    return Router(runner, store, joshua, catalog, operators=operators)


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


def test_status_reports_the_current_mode():
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
    not (GAMES_DIR / "tictactoe" / "harness" / "bin" / "tictactoe").exists(),
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
        for move in ("1", "2", "3", "4", "5", "6", "7", "8", "9"):
            result = await router.handle(session.id, move)
            if router.attachment(session.id).mode == JOSHUA:
                break
        else:
            pytest.fail("tictactoe never reached a terminal status in nine moves")
        assert router.attachment(session.id).mode == JOSHUA

    asyncio.run(flow())
