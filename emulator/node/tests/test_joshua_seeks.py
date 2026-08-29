"""The intention rides on JoshuaReply, beside start_game_id.

The dossier is the trigger (spec §4) because it is the one deterministic
beat both engines already share byte-identically. These tests pin that the
signal reaches Python from each engine, not that the text is right — the
golden fixtures already own the text.

Deterministic engines only: no anthropic import anywhere in this file, so it
collects and runs under a plain [dev] install (CI's node job). The Claude-only
tests live in test_joshua_claude_seeks.py, gated by their own module-level
importorskip — the same isolation test_joshua_claude.py already relies on.
"""
import asyncio
from pathlib import Path

import pytest

from app.games import load_catalog
from app.joshua import FALKEN_DOSSIER, JoshuaReply, ScriptedJoshua
from app.router import Router
from app.runner import CoreRunner, RunnerConfig
from app.store import MemoryStore

REPO = Path(__file__).resolve().parent.parent.parent.parent
GAMES_DIR = REPO / "games"


@pytest.fixture
def router_with_scripted_joshua() -> Router:
    """The smallest Router that can exercise the deterministic Joshua branch.

    Mirrors test_router.py's make_router; kept local here rather than
    promoted to a shared conftest fixture, since this is the only file that
    needs it so far."""
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=GAMES_DIR))
    joshua = ScriptedJoshua({g.id: g.title for g in catalog.values() if g.status == "implemented"})
    return Router(runner, store, {"scripted": joshua}, catalog)


def test_reply_defaults_to_no_intention():
    assert JoshuaReply(text="HELLO.").seeks is None


def test_scripted_engine_seeks_falken_with_the_dossier():
    joshua = ScriptedJoshua({})
    history = [
        {"role": "user", "content": "JOSHUA"},
        {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."},
    ]

    async def flow():
        reply = await joshua.chat("s1", history, "IS FALKEN DEAD?")
        assert reply.text == FALKEN_DOSSIER
        assert reply.seeks == "FALKEN"

    asyncio.run(flow())


def test_scripted_engine_seeks_nothing_otherwise():
    joshua = ScriptedJoshua({})

    async def flow():
        reply = await joshua.chat("s1", [], "HELLO")
        assert reply.seeks is None

    asyncio.run(flow())


def test_router_carries_seeks_up(router_with_scripted_joshua):
    """The host, not the program, decides what an intention means — so the
    intention has to survive the trip out of the router."""
    r = router_with_scripted_joshua

    async def flow():
        await r.handle("s1", "JOSHUA")
        result = await r.handle("s1", "IS FALKEN DEAD?")
        assert result.seeks == "FALKEN"

    asyncio.run(flow())


def test_router_reports_no_intention_for_an_ordinary_turn(router_with_scripted_joshua):
    async def flow():
        result = await router_with_scripted_joshua.handle("s1", "HELLO")
        assert result.seeks is None

    asyncio.run(flow())
