"""The monitor: the terminal is attached to one program, and everything typed
goes to it. These tests own the mode behaviour; test_router.py keeps the
destination behaviour it already had.

Async bodies run via asyncio.run() inside a plain `def test_...`, matching
test_router.py's convention — this suite has no pytest-asyncio plugin, so a
bare `async def test_...` would never execute."""

import asyncio
from pathlib import Path

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
