"""ClaudeJoshua's misconfiguration behaviour (deployment.md D5).

The engine only runs when JOSHUA_ENGINE=claude, and it is the one engine that
needs a secret. What happens when the secret is missing is a connection-level
concern: the Anthropic SDK raises TypeError from inside the request when no
auth header can be built, and TypeError is not an APIError, so it would escape
chat() and drop the socket instead of failing in character.
"""

from __future__ import annotations

import pytest

pytest.importorskip("anthropic", reason="anthropic not installed (pip install -e '.[prod]')")

from app.joshua import ClaudeJoshua  # noqa: E402


def _engine() -> ClaudeJoshua:
    return ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0)


def test_missing_key_still_sends_an_auth_header(monkeypatch):
    """No key configured at all -> an empty header, which earns a 401 the
    engine answers with FALLBACK_LINE. Not a headerless request, which raises."""
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    client = _engine()._client

    assert client.api_key == ""
    assert "X-Api-Key" in client.auth_headers


def test_configured_key_is_used(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")

    assert _engine()._client.api_key == "sk-ant-test"


def test_explicit_key_beats_the_environment(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-env")

    engine = ClaudeJoshua("claude-haiku-4-5-20251001", 300, 15.0, api_key="sk-ant-explicit")

    assert engine._client.api_key == "sk-ant-explicit"
