"""One behavioral contract, every store implementation.

Async style follows the repo convention: inner `async def flow()` +
`asyncio.run(flow())` (see tests/test_gtw.py) — no pytest-asyncio.
"""
from __future__ import annotations

import asyncio

import pytest

from app.main import DEFAULT_LINKS
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
    # postgres — the real schema, every migration applied (#83)
    from app.store import PostgresStore

    url = pgharness.pg_url()
    pgharness.apply_migrations(url)
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


def test_every_default_link_surface_mints(store):
    """Every surface `POST /api/session` accepts must survive the store it is
    written to — which, for PostgresStore, means surviving the
    `sessions_surface_check` CHECK constraint as the migrations actually left
    it in the database.

    This is the assertion #73 was missing. That bug was three copies of the
    surface allowlist disagreeing: `DEFAULT_LINKS` and the relay's
    `surface_links` had six, the constraint had three, and a machine-placed
    call therefore died in Postgres while every test stayed green — because
    the suite ran MemoryStore, which has no constraint to violate.
    `test_session_surfaces.py` compares the three lists as text; only this
    test asks the database.

    It iterates `DEFAULT_LINKS` rather than naming six surfaces, on purpose:
    a literal list here would be a fourth copy of the allowlist, and would go
    on passing the day somebody adds the seventh surface.
    """
    async def flow():
        for surface, profile in DEFAULT_LINKS.items():
            s = await store.create_session(surface, profile, None)
            got = await store.get_session(s.id)
            assert got is not None, f"{surface}: minted session did not read back"
            assert got.surface == surface
            assert got.link_profile == profile

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


def test_malformed_id_is_unknown_id(store):
    """A malformed id must behave exactly like an unknown id — never raise.
    Routes pass raw caller strings straight through (GET /api/session/{id},
    GET /api/games/{game_id}/state/{session_id}, POST /api/session/{id}/defcon,
    the WS handshake), so PostgresStore's `$1::uuid` casts must not turn a
    bad id into a 500 where MemoryStore would quietly report "unknown"."""
    async def flow():
        assert await store.get_session("attack") is None
        assert await store.get_active_game("attack") is None
        await store.set_defcon("attack", 3)  # no error, no-op
        assert await store.get_recent_events("attack") == []
        assert await store.get_system_state("attack") == ""

    asyncio.run(flow())


def test_exchange_register_and_list(store):
    async def flow():
        assert await store.list_exchanges() == []
        ok = await store.register_exchange(
            id="alpha", name="Alpha Exchange", region="US-East",
            api="https://alpha.example", link="wss://alpha.example/link",
            joshua="claude", operator="op1")
        assert ok is True
        # pending (approved=False) rows are invisible
        assert await store.list_exchanges() == []
        dup = await store.register_exchange(
            id="alpha", name="Other", region="Elsewhere",
            api="https://x.example", link="wss://x.example", joshua="period",
            operator=None)
        assert dup is False

    asyncio.run(flow())


@pytest.mark.skipif(not pgharness.pg_url(), reason="WOPR_TEST_DATABASE_URL not set")
def test_the_test_database_is_the_schema_the_pack_ships():
    """The test database must be at the pack's HEAD migration, not its baseline.

    The regression guard for #83's actual defect. `pgharness` used to name
    `0001_init.sql` — one file, not the directory — so `0002_session_surfaces.sql`
    was never applied and every test above ran against a schema still carrying
    the three-surface constraint #73 replaced. Nothing noticed, because a
    schema that is merely OLD fails no test that does not reach for what the
    new migration added.

    So: every migration on disk has a row in `schema_migrations`. A future
    `0003` that the harness does not apply fails here, by name.
    """
    import asyncpg

    url = pgharness.pg_url()
    pgharness.apply_migrations(url)

    async def flow():
        conn = await asyncpg.connect(url)
        try:
            rows = await conn.fetch("select version from schema_migrations")
        finally:
            await conn.close()
        applied = {r["version"] for r in rows}
        # The directory, NOT pgharness.migration_files() — asking the harness
        # what it applied and then checking it applied that is a tautology,
        # and the bug this guards was in the harness.
        on_disk = {p.stem for p in pgharness.MIGRATIONS.glob("*.sql")}
        assert on_disk, f"no migrations found in {pgharness.MIGRATIONS}"
        assert on_disk - applied == set(), (
            "these migrations were never applied to the test database: "
            f"{sorted(on_disk - applied)} — every test in this file ran "
            "against a schema the pack does not ship"
        )

    asyncio.run(flow())


@pytest.mark.skipif(not pgharness.pg_url(), reason="WOPR_TEST_DATABASE_URL not set")
def test_exchange_approved_row_flows_through_postgres():
    """Postgres-leg proof that an approved phone-book row actually flows
    through list_exchanges with the exact 7-key shape the /api/exchanges
    route returns. Approval has no API yet (application-layer force to
    approved=False on register, per db/migrations/0001_init.sql), so the
    only way to exercise the approved path is a direct SQL flip — this is
    that proof, not covered by the MemoryStore leg (which never touches SQL
    column ordering / row shape)."""
    from app.store import PostgresStore

    url = pgharness.pg_url()
    pgharness.apply_migrations(url)
    pgharness.truncate_all(url)

    async def flow():
        import asyncpg

        store = PostgresStore(url)
        ok = await store.register_exchange(
            id="beta", name="Beta Exchange", region="US-West",
            api="https://beta.example", link="wss://beta.example/link",
            joshua="period", operator="op2")
        assert ok is True
        assert await store.list_exchanges() == []  # still pending

        conn = await asyncpg.connect(url)
        try:
            await conn.execute(
                "update exchanges set approved = true where id = $1", "beta")
        finally:
            await conn.close()

        rows = await store.list_exchanges()
        assert rows == [{
            "id": "beta", "name": "Beta Exchange", "region": "US-West",
            "api": "https://beta.example", "link": "wss://beta.example/link",
            "joshua": "period", "operator": "op2",
        }]
        assert set(rows[0].keys()) == {
            "id", "name", "region", "api", "link", "joshua", "operator"}
        store._pool = None

    asyncio.run(flow())
