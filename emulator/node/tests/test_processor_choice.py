"""Per-session dialogue processor: registry, selection, and the D5 ceiling.

Spec: real-wopr docs/superpowers/specs/2026-07-26-joshua-processor-selection-design.md.
One Joshua, several reconstructions of him — a session picks which one answers,
and nothing is ever silently substituted.
"""

from __future__ import annotations

import asyncio
from datetime import date
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.budget import DailyBudget, MeteredJoshua
from app.games import load_catalog
from app.joshua import FALLBACK_LINE, JoshuaReply, ScriptedJoshua
from app.main import SELECTABLE_ENGINES, create_app
from app.router import Router
from app.runner import CoreRunner, RunnerConfig
from app.store import MemoryStore

PACK = Path(__file__).resolve().parents[3]
GAMES = PACK / "games"


class NamedJoshua:
    """Answers with its own name, so a test can see which engine replied."""

    def __init__(self, name: str):
        self.name = name
        self.calls = 0

    async def chat(self, session_id, history, user_text):
        self.calls += 1
        return JoshuaReply(text=f"I AM {self.name.upper()}.")


def make_router(engines, default=""):
    store = MemoryStore()
    catalog = load_catalog(GAMES)
    runner = CoreRunner(RunnerConfig(bin_dir=GAMES))
    return Router(runner, store, engines, catalog, default_engine=default), store


async def _say(router, store, text, engine=None):
    session = await store.create_session("home-terminal", "dialup-300", None)
    if engine:
        router.select_engine(session.id, engine)
    await router.handle(session.id, "JOSHUA")          # open the front door
    return (await router.handle(session.id, text)).text


# -- the registry ------------------------------------------------------------

def test_unselected_session_gets_the_exchange_default():
    router, store = make_router({"a": NamedJoshua("a"), "b": NamedJoshua("b")}, default="b")

    assert asyncio.run(_say(router, store, "HELLO")) == "I AM B."


def test_selection_is_honoured():
    router, store = make_router({"a": NamedJoshua("a"), "b": NamedJoshua("b")}, default="b")

    assert asyncio.run(_say(router, store, "HELLO", engine="a")) == "I AM A."


def test_two_sessions_can_run_different_processors_at_once():
    """The whole point: both live in one exchange, no redeploy between them."""
    a, b = NamedJoshua("a"), NamedJoshua("b")
    router, store = make_router({"a": a, "b": b}, default="a")

    async def flow():
        first = await store.create_session("home-terminal", "dialup-300", None)
        second = await store.create_session("home-terminal", "dialup-300", None)
        router.select_engine(second.id, "b")
        for s in (first, second):
            await router.handle(s.id, "JOSHUA")
        return ((await router.handle(first.id, "HELLO")).text,
                (await router.handle(second.id, "HELLO")).text)

    assert asyncio.run(flow()) == ("I AM A.", "I AM B.")
    assert (a.calls, b.calls) == (1, 1)


def test_selecting_something_the_exchange_lacks_raises():
    router, _ = make_router({"a": NamedJoshua("a")})

    with pytest.raises(KeyError):
        router.select_engine("some-session", "b")


def test_an_empty_registry_is_refused_at_construction():
    with pytest.raises(ValueError):
        make_router({})


def test_a_default_outside_the_registry_is_refused():
    with pytest.raises(ValueError):
        make_router({"a": NamedJoshua("a")}, default="b")


# -- the budget --------------------------------------------------------------

DAY = date(2026, 7, 26)
NEXT_DAY = date(2026, 7, 27)


def test_budget_counts_down_and_then_refuses():
    budget = DailyBudget(2)

    assert [budget.spend(DAY), budget.spend(DAY), budget.spend(DAY)] == [True, True, False]
    assert budget.available(DAY) is False


def test_budget_refills_at_utc_midnight():
    budget = DailyBudget(1)
    budget.spend(DAY)

    assert budget.available(DAY) is False
    assert budget.available(NEXT_DAY) is True


def test_a_zero_ceiling_serves_nothing():
    assert DailyBudget(0).available(DAY) is False


def test_exhausted_mid_session_answers_in_character_not_with_an_error():
    inner = NamedJoshua("claude")
    metered = MeteredJoshua(inner, DailyBudget(1))

    async def flow():
        return [(await metered.chat("s", [], "HELLO")).text for _ in range(2)]

    first, second = asyncio.run(flow())
    assert first == "I AM CLAUDE."
    assert second == FALLBACK_LINE
    assert inner.calls == 1, "a refused call must not reach the paid engine"


# -- the wire ----------------------------------------------------------------

@pytest.fixture
def client():
    engines = {"scripted": ScriptedJoshua({}), "lisp": NamedJoshua("lisp")}
    return TestClient(create_app(engines=engines))


def open_session(client, **body):
    return client.post("/api/session", json={"surface": "home-terminal", **body})


def test_health_advertises_what_the_exchange_can_serve(client):
    body = client.get("/health").json()

    assert body["joshua_processors"] == ["lisp"], "scripted is never selectable"
    assert body["joshua_default"] in ("lisp", "scripted")


def test_a_session_may_name_its_processor(client):
    res = open_session(client, joshua="lisp")

    assert res.status_code == 201
    assert res.json()["joshua"] == "lisp"


def test_the_name_is_case_insensitive(client):
    assert open_session(client, joshua="LISP").json()["joshua"] == "lisp"


def test_asking_for_nothing_reports_the_default(client):
    assert open_session(client).json()["joshua"] in ("lisp", "scripted")


@pytest.mark.parametrize("name", ["claude", "scripted", "nonsense", ""])
def test_an_unserveable_processor_is_refused_not_substituted(client, name):
    """claude has no key here, scripted is not selectable, the rest are typos.

    Every one is a 400. A session quietly given a different processor than it
    asked for would poison any comparison made with it.
    """
    res = open_session(client, joshua=name)

    assert res.status_code == 400
    assert "joshua" in res.json()["detail"]


def test_selectable_engines_excludes_the_fallback():
    assert "scripted" not in SELECTABLE_ENGINES
    assert {"lisp", "claude"} == set(SELECTABLE_ENGINES)
