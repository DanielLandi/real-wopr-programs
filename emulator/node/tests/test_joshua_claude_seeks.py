"""ClaudeJoshua's seek_falken tool wiring — parity, not load-bearing.

The evals run scripted and lisp, not claude, and this signal is inherently
nondeterministic (the model may or may not call the tool on a given turn).
These tests only pin: (1) the tool the API is actually offered includes
seek_falken, so a regression that silently drops it from tools=[...] would
be caught, and (2) when the model does call it, the value it names for `who`
reaches JoshuaReply.seeks unchanged.

Isolated in its own module, mirroring test_joshua_claude.py, so a
module-level importorskip("anthropic") skips only this file — not the
deterministic-engine tests in test_joshua_seeks.py, which must run under a
plain [dev] install (no anthropic) the way CI's node job does.
"""

from __future__ import annotations

import asyncio

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed (pip install -e '.[prod]')")

from types import SimpleNamespace  # noqa: E402

from app.joshua import FALKEN_DOSSIER, ClaudeJoshua  # noqa: E402


def _engine() -> ClaudeJoshua:
    return ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0, api_key="sk-ant-test")


class _StubMessages:
    """Captures the kwargs messages.create() was called with, so a test can
    assert on what was actually sent to the API — not just what came back."""

    def __init__(self, result):
        self._result = result
        self.calls: list[dict] = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._result


def test_both_tools_are_offered_to_the_model():
    engine = _engine()
    stub = _StubMessages(SimpleNamespace(content=[SimpleNamespace(type="text", text="HELLO.")]))
    engine._client = SimpleNamespace(messages=stub)

    asyncio.run(engine.chat("s1", [], "HELLO"))

    assert len(stub.calls) == 1
    tool_names = {tool["name"] for tool in stub.calls[0]["tools"]}
    assert tool_names == {"start_game", "seek_falken"}


def test_claude_engine_seeks_falken_when_the_model_calls_the_tool():
    engine = _engine()
    stub = _StubMessages(SimpleNamespace(content=[
        SimpleNamespace(type="text", text=FALKEN_DOSSIER),
        SimpleNamespace(type="tool_use", name="seek_falken", input={"who": "FALKEN"}),
    ]))
    engine._client = SimpleNamespace(messages=stub)

    reply = asyncio.run(engine.chat("s1", [], "IS FALKEN DEAD?"))

    assert reply.seeks == "FALKEN"


def test_claude_engine_seeks_nothing_when_the_model_does_not_call_the_tool():
    engine = _engine()
    stub = _StubMessages(SimpleNamespace(content=[SimpleNamespace(type="text", text="HELLO.")]))
    engine._client = SimpleNamespace(messages=stub)

    reply = asyncio.run(engine.chat("s1", [], "HELLO"))

    assert reply.seeks is None
