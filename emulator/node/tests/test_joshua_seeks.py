"""The intention rides on JoshuaReply, beside start_game_id.

The dossier is the trigger (spec §4) because it is the one deterministic
beat both engines already share byte-identically. These tests pin that the
signal reaches Python from each engine, not that the text is right — the
golden fixtures already own the text.
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


# --- ClaudeJoshua wiring (still no API calls: the client is stubbed) --------
# Parity only: the evals run scripted and lisp, not claude, and this signal
# is inherently nondeterministic (the model may or may not call the tool).

import pytest  # noqa: E402

anthropic = pytest.importorskip(
    "anthropic", reason="anthropic not installed (pip install -e '.[prod]')")

from types import SimpleNamespace  # noqa: E402

from app.joshua import ClaudeJoshua  # noqa: E402


class _StubMessages:
    def __init__(self, result):
        self._result = result

    async def create(self, **kwargs):
        return self._result


def test_claude_engine_seeks_falken_when_the_model_calls_the_tool():
    engine = ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0, api_key="sk-ant-test")
    response = SimpleNamespace(content=[
        SimpleNamespace(type="text", text=FALKEN_DOSSIER),
        SimpleNamespace(type="tool_use", name="seek_falken", input={"who": "FALKEN"}),
    ])
    engine._client = SimpleNamespace(messages=_StubMessages(response))

    reply = asyncio.run(engine.chat("s1", [], "IS FALKEN DEAD?"))

    assert reply.seeks == "FALKEN"


def test_claude_engine_seeks_nothing_when_the_model_does_not_call_the_tool():
    engine = ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0, api_key="sk-ant-test")
    response = SimpleNamespace(content=[SimpleNamespace(type="text", text="HELLO.")])
    engine._client = SimpleNamespace(messages=_StubMessages(response))

    reply = asyncio.run(engine.chat("s1", [], "HELLO"))

    assert reply.seeks is None
