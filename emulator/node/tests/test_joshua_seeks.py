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

from app.joshua import FALKEN_DOSSIER, JoshuaReply, ScriptedJoshua


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
