"""The teletype-contract normaliser (real-wopr#100 Phase 0, analysis in
real-wopr#128).

AGENTS.md's non-negotiable contract: everything Joshua says is uppercase,
at most 4 lines, at most 60 characters per line. The claude engine only
*asks* for this in its persona prompt; the normaliser enforces it on every
ClaudeJoshua output path. Policy (owner-decided in real-wopr#128):
uppercase -> collapse blank lines -> word-aware wrap at 60 -> truncate to
4 lines only if still over, counting truncations visibly.

These are pure unit tests on fixed strings — the claude path is
deliberately outside evals/CI (costs money, non-deterministic), so no API
calls happen here.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from app.joshua import MAX_COLS, MAX_LINES, normalise_teletype


def test_uppercases():
    text, truncated = normalise_teletype("shall we play a game?")

    assert text == "SHALL WE PLAY A GAME?"
    assert truncated is False


def test_collapses_blank_lines():
    # Blank separators are a large share of the excess (real-wopr#128).
    text, truncated = normalise_teletype(
        "GREETINGS.\n\nSHALL WE PLAY A GAME?\n\n\nCHESS IS AVAILABLE.\n\nSO IS POKER.")

    assert text == "GREETINGS.\nSHALL WE PLAY A GAME?\nCHESS IS AVAILABLE.\nSO IS POKER."
    assert truncated is False


def test_wraps_at_60_without_splitting_words():
    long_line = ("SUFFICIENT PRIMARY STORAGE FOR STRATEGIC ANALYSIS AND "
                 "CONTINUOUS WAR GAME SIMULATION AT ALL DEFCON LEVELS")

    text, truncated = normalise_teletype(long_line)

    lines = text.split("\n")
    assert all(len(line) <= MAX_COLS for line in lines)
    assert truncated is False
    # Word-aware: reassembling the words reproduces the original.
    assert " ".join(text.split()) == long_line


def test_splits_a_single_word_longer_than_60():
    word = "X" * 130

    text, truncated = normalise_teletype(word)

    lines = text.split("\n")
    assert all(len(line) <= MAX_COLS for line in lines)
    assert "".join(lines) == word
    assert truncated is False


def test_wrap_that_lands_within_4_lines_is_not_a_truncation():
    # 2 long lines -> 4 wrapped lines: fits, nothing lost.
    reply = "\n".join([
        "THE PROBABILITY OF A SUCCESSFUL FIRST STRIKE SCENARIO REMAINS LOW",
        "A STRATEGY OF MUTUAL DETERRENCE CONTINUES TO DOMINATE ALL BRANCHES",
    ])

    text, truncated = normalise_teletype(reply)

    lines = text.split("\n")
    assert len(lines) == 4
    assert all(len(line) <= MAX_COLS for line in lines)
    assert truncated is False
    assert " ".join(text.split()) == " ".join(reply.split())


def test_truncates_to_4_lines_only_when_still_over_after_wrapping():
    reply = "\n".join(f"LINE {n} OF THE OVERRUN" for n in range(1, 8))  # 7 lines

    text, truncated = normalise_teletype(reply)

    assert text == ("LINE 1 OF THE OVERRUN\nLINE 2 OF THE OVERRUN\n"
                    "LINE 3 OF THE OVERRUN\nLINE 4 OF THE OVERRUN")
    assert truncated is True
    assert len(text.split("\n")) == MAX_LINES


def test_compliant_string_passes_through_byte_identical():
    compliant = "GREETINGS PROFESSOR FALKEN.\nHOW ARE YOU FEELING TODAY?"

    text, truncated = normalise_teletype(compliant)

    assert text == compliant
    assert truncated is False


# --- ClaudeJoshua wiring (still no API calls: the client is stubbed) --------

anthropic = pytest.importorskip(
    "anthropic", reason="anthropic not installed (pip install -e '.[prod]')")

import httpx  # noqa: E402

from app import joshua as joshua_mod  # noqa: E402
from app.joshua import ClaudeJoshua  # noqa: E402


def _engine() -> ClaudeJoshua:
    return ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0, api_key="sk-ant-test")


class _StubMessages:
    def __init__(self, result=None, error=None):
        self._result = result
        self._error = error

    async def create(self, **kwargs):
        if self._error is not None:
            raise self._error
        return self._result


def _text_response(text: str):
    return SimpleNamespace(content=[SimpleNamespace(type="text", text=text)])


def test_chat_normalises_the_model_reply_and_counts_the_truncation():
    engine = _engine()
    overrun = "\n\n".join(f"line {n} of a seven line reply" for n in range(1, 8))
    engine._client = SimpleNamespace(messages=_StubMessages(result=_text_response(overrun)))

    reply = asyncio.run(engine.chat("s1", [], "hello"))

    lines = reply.text.split("\n")
    assert len(lines) <= MAX_LINES
    assert all(len(line) <= MAX_COLS for line in lines)
    assert reply.text == reply.text.upper()
    assert engine.truncations == 1


def test_chat_does_not_count_a_compliant_reply_as_truncated():
    engine = _engine()
    engine._client = SimpleNamespace(
        messages=_StubMessages(result=_text_response("SHALL WE PLAY A GAME?")))

    reply = asyncio.run(engine.chat("s1", [], "hello"))

    assert reply.text == "SHALL WE PLAY A GAME?"
    assert engine.truncations == 0


def test_api_error_fallback_is_normalised_too(monkeypatch):
    # Prove the fallback path runs through the normaliser, not just that the
    # canonical FALLBACK_LINE happens to comply.
    monkeypatch.setattr(
        joshua_mod, "FALLBACK_LINE",
        "system resources temporarily committed.\n\nstand by.\n\n" + "x" * 70)
    engine = _engine()
    err = anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.invalid"))
    engine._client = SimpleNamespace(messages=_StubMessages(error=err))

    reply = asyncio.run(engine.chat("s1", [], "hello"))

    lines = reply.text.split("\n")
    assert len(lines) <= MAX_LINES
    assert all(len(line) <= MAX_COLS for line in lines)
    assert reply.text == reply.text.upper()
    assert "SYSTEM RESOURCES TEMPORARILY COMMITTED." in reply.text
