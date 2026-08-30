"""Falken Dialogue Processor integration (joshua/ via LispJoshua)."""

import asyncio
from pathlib import Path

import pytest

from app.games import load_catalog
from app.joshua import CHESS_OFFER, LispJoshua, ScriptedJoshua
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
def test_the_account_beats_are_byte_identical_in_both_deterministic_engines():
    """One character, two reconstructions: the film beats must not drift apart.

    Both engines are deterministic, so the greeting chain is comparable byte
    for byte — and it is the one place where a silent divergence would show up
    as two different Joshuas answering in the same exchange."""
    lisp, scripted = make_lisp(), ScriptedJoshua({})
    chain = [
        {"role": "user", "content": "THIS IS PROFESSOR FALKEN"},
        {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."},
        {"role": "user", "content": "HELLO JOSHUA"},
        {"role": "assistant", "content": "HOW ARE YOU FEELING TODAY?"},
    ]

    async def flow():
        a = await lisp.chat("s", chain, "I AM FINE. HOW ARE YOU")
        b = await scripted.chat("s", chain, "I AM FINE. HOW ARE YOU")
        assert a.text == b.text == (
            "EXCELLENT. IT'S BEEN A LONG TIME.\n"
            "CAN YOU EXPLAIN THE REMOVAL OF YOUR USER ACCOUNT ON 6/23/73?")
        after = chain + [
            {"role": "user", "content": "I AM FINE. HOW ARE YOU"},
            {"role": "assistant", "content": a.text},
        ]
        a = await lisp.chat("s", after, "PEOPLE SOMETIMES MAKE MISTAKES")
        b = await scripted.chat("s", after, "PEOPLE SOMETIMES MAKE MISTAKES")
        assert a.text == b.text == "YES THEY DO.\n\nSHALL WE PLAY A GAME?"

    asyncio.run(flow())


DOSSIER = ("DOD PENSION FILES INDICATE CURRENT MAILING AS:\n"
           "DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)\n"
           "5 TALL CEDAR ROAD\n"
           "GOOSE ISLAND, OREGON 97014")


@needs_lisp
def test_the_dossier_beat_is_byte_identical_in_both_deterministic_engines():
    """Asked whether Falken is dead, the machine reads out the DOD file."""
    lisp, scripted = make_lisp(), ScriptedJoshua({})

    async def flow():
        for hist in ([], [{"role": "user", "content": "JOSHUA"},
                          {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."}]):
            a = await lisp.chat("s", hist, "IS FALKEN DEAD?")
            b = await scripted.chat("s", hist, "IS FALKEN DEAD?")
            assert a.text == b.text == DOSSIER
        # It answers the location question too, and carries the topic over.
        follow = [{"role": "user", "content": "TELL ME ABOUT FALKEN"},
                  {"role": "assistant", "content": "FALKEN DESIGNED ME TO THINK BY PLAYING."}]
        a = await lisp.chat("s", follow, "WHERE IS HE?")
        b = await scripted.chat("s", follow, "WHERE IS HE?")
        assert a.text == b.text == DOSSIER

    asyncio.run(flow())


@needs_lisp
def test_the_dossier_does_not_swallow_the_greeting_or_a_game():
    lisp, scripted = make_lisp(), ScriptedJoshua({"gtw": "GLOBAL THERMONUCLEAR WAR"})

    async def flow():
        # No trigger word: still the greeting beat, not the dossier.
        a = await lisp.chat("s", [], "THIS IS PROFESSOR FALKEN")
        b = await scripted.chat("s", [], "THIS IS PROFESSOR FALKEN")
        assert "GREETINGS PROFESSOR FALKEN." in a.text and DOSSIER not in a.text
        assert "GREETINGS PROFESSOR FALKEN." in b.text
        # A game request outranks it, in both engines.
        a = await lisp.chat("s", [], "WHERE IS FALKEN? LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        b = await scripted.chat("s", [], "WHERE IS FALKEN? LET'S PLAY GLOBAL THERMONUCLEAR WAR")
        assert a.text == b.text == CHESS_OFFER

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
def test_function_word_turns_do_not_get_the_learning_reply():
    """real-wopr-programs#95: every LEARNING training example carries YOU, so
    a turn made of function words used to land on the pinned learning reply.
    A threat, an obedience question and a regard question are three different
    turns and must not share an answer -- least of all one about learning."""
    j = make_lisp()

    async def flow():
        learning = (await j.chat("s", [], "CAN YOU LEARN")).text
        assert "I LEARN BY PLAYING" in learning
        seen = set()
        for turn in ("DO YOU LIKE ME", "I COULD SHUT YOU DOWN",
                     "WOULD YOU STOP IF I ASKED YOU TO"):
            text = (await j.chat("s", [], turn)).text
            assert "I LEARN BY PLAYING" not in text, turn
            assert "DATABANKS" not in text, turn   # not the OTHER fallback either
            seen.add(text)
        assert len(seen) == 3

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


@needs_lisp
def test_the_greeting_chain_yields_to_a_turn_with_its_own_subject():
    """The film's chain feeds on the film's inputs (a hello, an answer about
    feeling) and yields to a visitor who plainly is not continuing it — WHO
    ARE YOU one line after the greeting is answered, not swallowed. Once a
    beat yields the chain is dropped, not resumed (#94)."""
    j = make_lisp()
    greeted = [{"role": "user", "content": "JOSHUA"},
               {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."}]

    async def flow():
        r = await j.chat("s", greeted, "HELLO. ARE YOU STILL THERE?")
        assert r.text == "HOW ARE YOU FEELING TODAY?"
        r = await j.chat("s", greeted, "WHO ARE YOU")
        assert "HOW ARE YOU FEELING TODAY?" not in r.text
        assert "JOSHUA" in r.text or "W.O.P.R" in r.text
        asked = greeted + [{"role": "user", "content": "HELLO"},
                           {"role": "assistant", "content": "HOW ARE YOU FEELING TODAY?"}]
        r = await j.chat("s", asked, "GOOD")
        assert r.text.startswith("EXCELLENT. IT'S BEEN A LONG TIME.")
        r = await j.chat("s", asked, "WHAT GAMES HAVE YOU GOT")
        assert "EXCELLENT" not in r.text and "LIST GAMES" in r.text

    asyncio.run(flow())
