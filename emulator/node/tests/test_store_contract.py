"""One behavioral contract, every store implementation.

Async style follows the repo convention: inner `async def flow()` +
`asyncio.run(flow())` (see tests/test_gtw.py) — no pytest-asyncio.
"""
from __future__ import annotations

import asyncio

import pytest

from app.store import GLOBAL_ROOM_KEY, GameState, MemoryStore

import pgharness  # sibling test module (pytest prepends tests/ to sys.path; no tests package exists)

FACTORIES = ["memory"]
if pgharness.pg_url():
    FACTORIES.append("postgres")


@pytest.fixture(params=FACTORIES)
def store(request):
    if request.param == "memory":
        yield MemoryStore()
        return
    # postgres — wired in Task 3
    from app.store import PostgresStore

    url = pgharness.pg_url()
    pgharness.apply_schema(url)
    pgharness.truncate_all(url)
    s = PostgresStore(url)
    yield s
    # pool is loop-bound to the test's own asyncio.run(); nothing to close here
    s._pool = None


def test_session_roundtrip_and_defcon(store):
    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        assert s.defcon == 5 and s.user_id is None
        got = await store.get_session(s.id)
        assert got is not None and got.surface == "home-terminal"
        await store.set_defcon(s.id, 3)
        assert (await store.get_session(s.id)).defcon == 3
        assert await store.get_session("00000000-0000-0000-0000-000000000000") is None

    asyncio.run(flow())


def test_operator_and_clearance(store):
    async def flow():
        s = await store.create_session("norad-terminal", "dialup-300", None)
        assert await store.get_clearance_level(None) == 5
        assert await store.get_clearance_level("NORAD-3") == 5  # unknown -> least privileged
        await store.set_operator(s.id, "NORAD-3", 2)
        assert (await store.get_session(s.id)).user_id == "NORAD-3"
        assert await store.get_clearance_level("NORAD-3") == 2

    asyncio.run(flow())


def test_game_lifecycle_upsert_and_active(store):
    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        assert await store.get_active_game(s.id) is None
        await store.upsert_game(GameState(session_id=s.id, game_id="gtw", state="S1", status="PLAYING", turn=1))
        g = await store.get_active_game(s.id)
        assert g is not None and g.state == "S1" and g.turn == 1
        await store.upsert_game(GameState(session_id=s.id, game_id="gtw", state="S2", status="PLAYING", turn=2))
        g = await store.get_active_game(s.id)
        assert g.state == "S2" and g.turn == 2
        await store.upsert_game(GameState(session_id=s.id, game_id="gtw", state="S2", status="NO-WIN", turn=2))
        assert await store.get_active_game(s.id) is None

    asyncio.run(flow())


def test_latest_game_room_scoping(store):
    async def flow():
        room = await store.create_room()
        in_room = await store.create_session("home-terminal", "dialup-300", None, room_code=room.code)
        global_s = await store.create_session("home-terminal", "dialup-300", None)
        await store.upsert_game(GameState(session_id=in_room.id, game_id="gtw", state="R", status="PLAYING"))
        await store.upsert_game(GameState(session_id=global_s.id, game_id="gtw", state="G", status="PLAYING"))
        got = await store.get_latest_game("gtw", room_code=room.code)
        assert got is not None and got.state == "R"
        got = await store.get_latest_game("gtw", room_code=GLOBAL_ROOM_KEY)
        assert got is not None and got.state == "G"
        assert await store.get_latest_game("gtw", room_code="ZZZZZZ") is None

    asyncio.run(flow())


def test_room_idempotency_and_touch(store):
    async def flow():
        r1 = await store.create_room("ABCDEF")
        r2 = await store.create_room("ABCDEF")   # never resets, returns existing
        assert r1.code == r2.code == "ABCDEF"
        assert r1.created_at == r2.created_at  # idempotent: same created_at
        assert (await store.get_room("ABCDEF")) is not None
        assert (await store.get_room("NOPE00")) is None
        # Touch room and verify last_seen_at is updated
        room_before = await store.get_room("ABCDEF")
        assert room_before is not None
        last_seen_before = room_before.last_seen_at
        await store.touch_room("ABCDEF")
        room_after = await store.get_room("ABCDEF")
        assert room_after is not None
        assert room_after.last_seen_at >= last_seen_before
        generated = await store.create_room()
        assert len(generated.code) == 6 and generated.code != "ABCDEF"

    asyncio.run(flow())


def test_events_order_and_limit(store):
    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        for i in range(5):
            await store.log_event(s.id, "input", "user", {"n": i})
        events = await store.get_recent_events(s.id, limit=3)
        assert [e["payload"]["n"] for e in events] == [2, 3, 4]  # oldest -> newest tail

    asyncio.run(flow())


def test_system_state_default_empty(store):
    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None, system_id="sys-1")
        assert await store.get_system_state(s.id) == ""
        await store.set_system_state(s.id, "BLOCK")
        assert await store.get_system_state(s.id) == "BLOCK"

    asyncio.run(flow())
