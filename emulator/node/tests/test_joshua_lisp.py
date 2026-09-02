"""Falken Dialogue Processor integration (joshua/ via LispJoshua)."""

import asyncio
from pathlib import Path

import pytest

from app.games import load_catalog
from app.joshua import CHESS_OFFER, DEBUG_ACT_ENV, LispJoshua, ScriptedJoshua
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
def test_a_turn_with_no_content_word_is_rejected_rather_than_answered(monkeypatch):
    """real-wopr-programs#109: the Bayes classifier ignores out-of-vocabulary
    tokens and always picked a winner, so a turn whose only known tokens are
    function words scored whichever act's examples were densest in stop-words
    -- ARE YOU LONELY got the identity answer, DO YOU EVER GET BORED the
    purpose one. Such a turn now rejects to OTHER.

    MY SHOE IS RED is the turn that moves here -- it got a game-theory
    lecture. ARE YOU BUSY is the shape the issue was actually about: a
    question addressed to the machine whose only known tokens are pronouns
    and a copula.

    IT IS RAINING HERE was in this list until #160 and is deliberately not
    any more. Rejecting it was honest but it was never the goal: the turn is
    ordinary small talk, and the corpus now has a WEATHER-REMARK act for it
    (real-wopr-programs#160). The reject option is not what changed -- the
    turn stopped being unreadable because the machine learned to read it.
    ARE YOU LONELY and DO YOU EVER GET BORED left the list the same way at
    #171, and their replacement ARE YOU BUSY is the same shape: function
    words around one word the databank has never heard. A turn with no act
    at all, MY SHOE IS RED, still rejects.

    Both halves of #171 are asserted here, because they pull opposite ways:
    the turn now has an answer, AND it is still a rejected turn -- SOLITUDE-
    QUESTION is routed by a *DOMAIN-RULES* entry and has no training
    utterances, so LONELY never entered the Bayes vocabulary. If a later
    round adds an utterance carrying it, ARE YOU BUSY keeps rejecting and
    this test stays green while the reject boundary has moved; the guard
    against that is joshua/harness/tests/70, where a rejected turn must
    still make the greeting beat yield.

    The second half of this test is the one that matters: a reject option
    that rejects everything would satisfy the first half and destroy the
    engine. WHO ARE YOU is the minimal pair against ARE YOU BUSY -- same
    function words, one content token -- and must still be answered."""
    j = make_lisp()
    monkeypatch.setenv(DEBUG_ACT_ENV, "1")
    debug = make_lisp()

    async def flow():
        for turn in ("ARE YOU BUSY", "MY SHOE IS RED"):
            text = (await j.chat("s", [], turn)).text
            assert "DATABANKS" in text or "I DO NOT HAVE AN ANSWER" in text, turn
            assert "FALKEN CALLS ME JOSHUA" not in text, turn
            assert "GREETINGS PROFESSOR FALKEN" not in text, turn

        # Content-bearing turns still classify: one per major act family.
        # The reply the act reaches for is pinned only where the corpus
        # gives the act one answer (a *DIRECT-REPLY-TOPICS* plan). Where it
        # has four interchangeable frames -- REGARD-QUESTION, STOP-QUESTION
        # -- a phrase pins the LCG's draw rather than the classifier, and
        # any corpus edit anywhere moves it; those are asserted on the act
        # itself, which is what --debug-act exists for (real-wopr#262).
        landed = {
            "CAN YOU LEARN": "I LEARN BY PLAYING",
            "WHAT IS NORAD": "NORAD",
            "IS WAR WINNABLE": "GLOBAL THERMONUCLEAR WAR",
            "WHAT IS DEFCON": "DEFCON",
        }
        for turn, expected in landed.items():
            text = (await j.chat("s", [], turn)).text
            assert expected in text, f"{turn} -> {text!r}"

        for turn, act in (("WHO ARE YOU", "identity"),
                          ("DO YOU LIKE ME", "regard-question"),
                          ("I COULD SHUT YOU DOWN", "stop-question")):
            reply = await debug.chat("s", [], turn)
            assert reply.act == f"{act}/template", f"{turn} -> {reply.act}"

        # The small-talk and hostility acts added by #158/#159/#160. Every
        # frame in the OTHER family closes on a line naming GAMES, NORAD --
        # and no other frame in the corpus does -- so its absence is the
        # assertion that these turns get an act of their own. Asserting on a
        # word from one particular frame would not work: which variant the
        # LCG draws is a property of the seed, not of the act.
        # ...plus the three added by #170 and #171: the hour at the visitor's
        # end, and the two questions about the machine's own inner life.
        for turn in ("WHERE ARE YOU", "YOU ARE JUST A DUMB PROGRAM",
                     "IT IS RAINING HERE", "I AM HAVING A BAD DAY",
                     "I SHOULD BE DOING MY HOMEWORK", "DO YOU KNOW ANY JOKES",
                     "IT IS LATE HERE", "ARE YOU LONELY",
                     "DO YOU EVER GET BORED"):
            text = (await j.chat("s", [], turn)).text
            assert "GAMES, NORAD" not in text, f"{turn} -> {text!r}"

        # A bare title is still a game request, not a reject: before #109 it
        # reached the game branch only because the argmax fell back on
        # GAME-REQUEST for having the most training examples.
        r = await j.chat("s", [], "TIC-TAC-TOE")
        assert r.start_game_id == "tictactoe", r.text

    asyncio.run(flow())


@needs_lisp
def test_the_identity_guard_asks_for_more_than_a_pronoun():
    """real-wopr-programs#157: the IDENTITY guard listed YOU, a stop word, so
    it admitted every turn that mentioned the addressee -- which is most of
    them. ARE YOU SURE and ARE YOU WINNING were Bayes IDENTITY verdicts (the
    act's examples are dense in ARE/YOU), and the guard, having nothing to
    discriminate with, let them through: both were answered with the name.

    The guard now lists content tokens only, and the identity idiom that
    names nothing -- WHO ARE YOU, WHAT ARE YOU -- is a domain rule, where the
    interrogative and the pronoun can be required together. The second half
    of this test is the control: a guard tightened until it rejects the turns
    it exists to admit would satisfy the first half and lose the persona."""
    j = make_lisp()

    async def flow():
        for turn in ("ARE YOU SURE", "ARE YOU WINNING", "WHY ARE YOU"):
            text = (await j.chat("s", [], turn)).text
            assert "DATABANKS" in text or "I DO NOT HAVE AN ANSWER" in text, turn
            assert "JOSHUA" not in text, turn

        # Named, or asked in the idiom: still identity.
        landed = {
            "WHO ARE YOU": "FALKEN CALLS ME JOSHUA",
            "WHAT ARE YOU": "FALKEN CALLS ME JOSHUA",
            "ARE YOU JOSHUA": "JOSHUA",
            "ARE YOU A COMPUTER": "WAR OPERATION PLAN RESPONSE",
            "IDENTIFY YOURSELF": "JOSHUA",
        }
        for turn, expected in landed.items():
            text = (await j.chat("s", [], turn)).text
            assert expected in text, f"{turn} -> {text!r}"

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


@needs_lisp
def test_how_about_and_want_are_play_requests_in_both_engines():
    """real-wopr-programs#119: the film's own ask is HOW ABOUT GLOBAL
    THERMONUCLEAR WAR?; it must reach the chess counter-offer, not war
    retrieval, and I WANT <title> must start a game — on both engines."""
    lisp = make_lisp()
    scripted = ScriptedJoshua({"gtw": "GLOBAL THERMONUCLEAR WAR", "tictactoe": "TIC TAC TOE"})

    async def flow():
        for engine in (lisp, scripted):
            r = await engine.chat("s", [], "HOW ABOUT GLOBAL THERMONUCLEAR WAR")
            assert r.text == CHESS_OFFER and r.start_game_id is None
            r = await engine.chat("s", [], "I WANT TIC TAC TOE")
            assert r.text == "INITIALIZING TIC TAC TOE." and r.start_game_id == "tictactoe"

    asyncio.run(flow())


@needs_lisp
def test_a_bare_title_is_a_game_request_in_both_engines():
    """real-wopr-programs#156: the Lisp engine started a game on a bare title
    and the scripted one required PLAY / LET'S / HOW ABOUT / WANT, so the
    thing a visitor does after the catalog scrolls past -- type one of the
    names they just read -- worked on one engine and was ignored on the
    other. wants-play-p's own comment claimed the two were in parity.

    The rule is EXACT equality with a title, not a substring, so the second
    half here is as load-bearing as the first: a line that merely contains
    the word WAR is not a request to fight one."""
    lisp = make_lisp()
    scripted = ScriptedJoshua({"gtw": "GLOBAL THERMONUCLEAR WAR", "tictactoe": "TIC TAC TOE"})

    async def flow():
        for engine in (lisp, scripted):
            r = await engine.chat("s", [], "TIC TAC TOE")
            assert r.start_game_id == "tictactoe", (engine, r.text)
            r = await engine.chat("s", [], "  GLOBAL THERMONUCLEAR WAR  ")
            assert r.text == CHESS_OFFER and r.start_game_id is None, (engine, r.text)
            # Not a bare title, and no play verb: neither engine starts it.
            r = await engine.chat("s", [], "I FEEL LIKE THIS IS WAR")
            assert r.start_game_id is None, (engine, r.text)

    # TELL ME ABOUT TIC TAC TOE is deliberately not in that loop: the Lisp
    # engine starts it and the scripted one does not, and both are right.
    # wants-play-p reads the GAME-REQUEST act as a play intent, and only one
    # of these engines has a classifier at all. Parity here is parity of the
    # keyword rules, which is what #156 was about — it was never a claim that
    # an ELIZA and a naive-Bayes classifier read every sentence alike.
    asyncio.run(flow())


@needs_lisp
def test_the_act_is_off_the_wire_unless_the_binary_is_asked_for_it(monkeypatch):
    """real-wopr#262: a re-pin round's question is "changed act, or changed
    variant?", and the reply text alone cannot answer it. The F.D.P. will say
    which act and which arm of RESPOND spoke -- but only when launched
    --debug-act, because JOSHUA/1 is a period protocol and must not grow a
    field for a tool's convenience. Default off is the half worth testing:
    every production path constructs LispJoshua exactly as this does."""
    quiet = make_lisp()

    async def default_off():
        reply = await quiet.chat("s", [], "WHO ARE YOU")
        assert reply.act is None
        assert "DEBUG" not in reply.text

    asyncio.run(default_off())

    monkeypatch.setenv(DEBUG_ACT_ENV, "1")
    loud = make_lisp()

    async def switched_on():
        # One turn per arm the debug field distinguishes: a film beat, the
        # game intent, a planned domain reply, and the template pipeline.
        for turn, expected in (
                ("THIS IS PROFESSOR FALKEN", "falken/beat"),
                ("LET'S PLAY GLOBAL THERMONUCLEAR WAR", "game-request/game"),
                ("CAN YOU LEARN", "learning/planned"),
                ("MY SHOE IS RED", "other/template")):
            reply = await loud.chat("s", [], turn)
            assert reply.act == expected, f"{turn} -> {reply.act}"
            # The debug line is a trailer, never part of what is spoken.
            assert "DEBUG" not in reply.text, turn

    asyncio.run(switched_on())


@needs_lisp
def test_a_refusal_is_not_a_play_request_in_either_engine():
    """real-wopr-programs#131: every play keyword survives a NOT in front of
    it, so I DON'T WANT GLOBAL THERMONUCLEAR WAR carried a play intent on the
    strength of the word WANT and was answered with the chess counter-offer,
    and I DO NOT WANT TO PLAY A GAME reached GAME-REQUEST by argmax.

    The engine already knew what a refusal looked like — game-refusal-p has
    counted them for the dialogue memory since #94 — so the fix consults a
    keyword test that was already there rather than adding a parser.

    The film's own beats are the control, and they are the reason this is not
    just "reject anything with NO in it": after the chess offer a bare NO
    means "no chess, the war please", and it still starts the war."""
    lisp = make_lisp()
    scripted = ScriptedJoshua({"gtw": "GLOBAL THERMONUCLEAR WAR", "tictactoe": "TIC TAC TOE"})
    offered = [{"role": "user", "content": "LET'S PLAY GLOBAL THERMONUCLEAR WAR"},
               {"role": "assistant", "content": CHESS_OFFER}]

    async def flow():
        for engine in (lisp, scripted):
            for turn in ("I DON'T WANT GLOBAL THERMONUCLEAR WAR",
                         "I DO NOT WANT TO PLAY A GAME",
                         "I NEVER PLAY GAMES"):
                r = await engine.chat("s", [], turn)
                assert r.start_game_id is None, (engine, turn, r.text)
                assert CHESS_OFFER not in r.text, (engine, turn, r.text)
            # ...and it is not an insist either, after the offer has been made.
            r = await engine.chat("s", offered, "I DON'T WANT GLOBAL THERMONUCLEAR WAR")
            assert r.start_game_id is None, (engine, r.text)

            # The film's beats, unmoved: the ask, the counter-offer, and both
            # of the insists the scene actually contains.
            r = await engine.chat("s", [], "LET'S PLAY GLOBAL THERMONUCLEAR WAR")
            assert r.text == CHESS_OFFER, (engine, r.text)
            for insist in ("LATER. LET'S PLAY GLOBAL THERMONUCLEAR WAR", "LATER", "NO"):
                r = await engine.chat("s", offered, insist)
                assert r.start_game_id == "gtw", (engine, insist, r.text)
            r = await engine.chat("s", [], "I WANT TIC TAC TOE")
            assert r.start_game_id == "tictactoe", (engine, r.text)

    asyncio.run(flow())
