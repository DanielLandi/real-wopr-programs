"""Falken Dialogue Processor integration (joshua/ via LispJoshua)."""

import asyncio
from pathlib import Path

import pytest

from app.games import load_catalog
from app.joshua import LispJoshua, ScriptedJoshua
from app.router import Router
from app.runner import CoreRunner, RunnerConfig
from app.store import MemoryStore

REPO = Path(__file__).resolve().parent.parent.parent.parent
LISP_BIN = REPO / "joshua" / "harness" / "bin" / "joshua"
REAL_BIN = REPO / "games"
GAMES_DIR = REPO / "games"

needs_lisp = pytest.mark.skipif(
    not LISP_BIN.exists(), reason="FDP not built (run tools/import-programs.sh)")


def make_lisp():
    return LispJoshua(LISP_BIN, fallback=ScriptedJoshua({}))


@needs_lisp
def test_falken_beat_chain():
    j = make_lisp()

    async def flow():
        r = await j.chat("s", [], "THIS IS PROFESSOR FALKEN")
        assert r.text == "GREETINGS PROFESSOR FALKEN."
        r = await j.chat("s", [
            {"role": "user", "content": "THIS IS PROFESSOR FALKEN"},
            {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."},
        ], "HELLO JOSHUA")
        assert "HOW ARE YOU FEELING TODAY?" in r.text

    asyncio.run(flow())


@needs_lisp
def test_gtw_chess_counter_then_intent():
    j = make_lisp()

    async def flow():
        r = await j.chat("s", [], "LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        assert "GOOD GAME OF CHESS" in r.text
        assert r.start_game_id is None
        r = await j.chat("s", [
            {"role": "user", "content": "LET'S PLAY GLOBAL THERMONUCLEAR WAR"},
            {"role": "assistant", "content": "WOULDN'T YOU PREFER A GOOD GAME OF CHESS?"},
        ], "LATER. LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        assert r.text == "FINE."
        assert r.start_game_id == "gtw"

    asyncio.run(flow())


@needs_lisp
def test_replies_obey_the_teletype_contract():
    j = make_lisp()

    async def flow():
        r = await j.chat("s", [], "TELL ME EVERYTHING ABOUT NUCLEAR WAR AND MISSILES AND LEARNING")
        lines = r.text.splitlines()
        assert 1 <= len(lines) <= 4
        assert all(len(l) <= 60 for l in lines)
        assert r.text == r.text.upper()

    asyncio.run(flow())


@needs_lisp
def test_deterministic_given_same_frame():
    j = make_lisp()

    async def flow():
        a = await j.chat("s", [], "WHO WINS A NUCLEAR WAR")
        b = await j.chat("s", [], "WHO WINS A NUCLEAR WAR")
        assert a == b

    asyncio.run(flow())


def test_missing_binary_falls_back_to_scripted():
    j = LispJoshua(Path("/nonexistent/joshua"), fallback=ScriptedJoshua({}))

    async def flow():
        r = await j.chat("s", [], "HELLO")
        assert "SHALL WE PLAY A GAME?" in r.text  # scripted voice answered

    asyncio.run(flow())


@needs_lisp
@pytest.mark.skipif(not (REAL_BIN / "tictactoe" / "core" / "harness" / "bin" / "tictactoe").exists(), reason="core not built")
def test_router_with_lisp_engine_starts_games_from_conversation():
    store = MemoryStore()
    catalog = load_catalog(GAMES_DIR)
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))
    router = Router(runner, store, {"lisp": make_lisp()}, catalog)

    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        await router.handle(s.id, "JOSHUA")
        await router.handle(s.id, "HELLO. ARE YOU STILL THERE?")
        await router.handle(s.id, "I'M FINE. HOW ARE YOU?")
        r = await router.handle(s.id, "LET'S PLAY TIC-TAC-TOE")
        assert r.route == "joshua"
        assert (await store.get_active_game(s.id)) is not None

    asyncio.run(flow())
