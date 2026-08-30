"""One behavioral contract, every store implementation.

Async style follows the repo convention: inner `async def flow()` +
`asyncio.run(flow())` (see tests/test_gtw.py) — no pytest-asyncio.
"""
from __future__ import annotations

import asyncio
import re
import uuid

import pytest

from app.main import DEFAULT_LINKS
from app.store import (EVENT_ACTORS, EVENT_KINDS, EXCHANGE_JOSHUAS, GAME_STATUSES,
                       GLOBAL_ROOM_KEY, SESSION_SURFACES, GameState, MemoryStore)

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


def test_every_event_kind_and_actor_logs(store):
    """Every kind and actor the bridge logs must survive `event_logs`' two
    CHECK constraints as the migrations left them. Same shape as the surface
    test above (#91): the sets are iterated, not restated, so the day
    somebody adds a kind to `EVENT_KINDS` and not to a migration, the
    Postgres leg of this test is the thing that says so."""
    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        for kind in sorted(EVENT_KINDS):
            await store.log_event(s.id, kind, "system", {"kind": kind})
        for actor in sorted(EVENT_ACTORS):
            await store.log_event(s.id, "route", actor, {"actor": actor})
        events = await store.get_recent_events(s.id, limit=100)
        assert {e["kind"] for e in events} == set(EVENT_KINDS)
        assert {e["actor"] for e in events} == set(EVENT_ACTORS)

    asyncio.run(flow())


def test_every_game_status_upserts(store):
    """Every status the bridge can write — the wire's, plus its own QUIT —
    must survive `game_states_status_check`. Read back with
    `playing_only=False`: a finished game is exactly the case."""
    async def flow():
        for status in sorted(GAME_STATUSES):
            s = await store.create_session("home-terminal", "dialup-300", None)
            await store.upsert_game(GameState(
                session_id=s.id, game_id=f"g-{status.lower()}", state="S", status=status))
            got = await store.get_latest_game(f"g-{status.lower()}", playing_only=False)
            assert got is not None, f"{status}: upserted game did not read back"
            assert got.status == status

    asyncio.run(flow())


def test_every_exchange_joshua_registers(store):
    """Every reconstruction of Joshua the register API offers must survive
    `exchanges.joshua`'s CHECK — the column the issue (#91) expected to bite
    next, because engine names are the kind of thing that gets added."""
    async def flow():
        for joshua in sorted(EXCHANGE_JOSHUAS):
            ok = await store.register_exchange(
                id=f"x-{joshua}", name=f"Exchange {joshua}", region="Nowhere",
                api="https://x.example", link="wss://x.example", joshua=joshua,
                operator=None)
            assert ok is True, f"{joshua}: registration refused"

    asyncio.run(flow())


def test_a_value_outside_the_enumeration_is_refused(store):
    """The guard has to fire, not just the happy path pass. Postgres refuses
    with its CHECK; MemoryStore refuses with ValueError — the point being that
    a call site inventing a new kind fails the in-memory suite, which is the
    suite everything runs, rather than Neon."""
    import asyncpg

    refused = (ValueError, asyncpg.exceptions.CheckViolationError)

    async def flow():
        s = await store.create_session("home-terminal", "dialup-300", None)
        # The #73 column itself — the one enumeration the in-memory store
        # still let through after #110 (#111).
        with pytest.raises(refused):
            await store.create_session("teletype-33", "dialup-110", None)
        with pytest.raises(refused):
            await store.log_event(s.id, "telemetry", "system", {})
        with pytest.raises(refused):
            await store.log_event(s.id, "route", "operator", {})
        with pytest.raises(refused):
            await store.upsert_game(GameState(session_id=s.id, game_id="g", state="S", status="ABORT"))
        with pytest.raises(refused):
            await store.register_exchange(
                id="x-bogus", name="Bogus", region="Nowhere", api="https://x.example",
                link="wss://x.example", joshua="hal9000", operator=None)

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


def test_exchange_rows_are_read_from_every_session(store):
    """Rows logged with `session_id=None` are the exchange's — a peer
    registering, a machine calling in (#88) — and every session's journal
    carries them, interleaved in order with its own rows, under the same
    limit. Another session's rows stay its own (E10)."""
    async def flow():
        a = await store.create_session("norad-terminal", "leased-9600", None)
        b = await store.create_session("norad-terminal", "leased-9600", None)
        await store.log_event(a.id, "input", "user", {"n": "a1"})
        await store.log_event(None, "route", "system", {"origin": "world 1 slot PANAM"})
        await store.log_event(b.id, "input", "user", {"n": "b1"})
        await store.log_event(a.id, "input", "user", {"n": "a2"})
        seen_a = await store.get_recent_events(a.id, limit=10)
        assert [e["payload"] for e in seen_a] == [
            {"n": "a1"}, {"origin": "world 1 slot PANAM"}, {"n": "a2"}]
        assert [e["session_id"] for e in seen_a] == [a.id, None, a.id]
        seen_b = await store.get_recent_events(b.id, limit=10)
        assert [e["payload"] for e in seen_b] == [
            {"origin": "world 1 slot PANAM"}, {"n": "b1"}]
        # The limit is a limit on the journal, exchange rows included.
        assert [e["payload"] for e in await store.get_recent_events(a.id, limit=1)] == [
            {"n": "a2"}]

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
        # ...even when the exchange has rows of its own to show (#88).
        await store.log_event(None, "route", "system", {"event": "exchange-registered"})
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


@pytest.mark.skipif(not pgharness.pg_url(), reason="WOPR_TEST_DATABASE_URL not set")
def test_exchange_rows_are_read_through_the_session_index():
    """The exchange-row arm of `get_recent_events` (`or session_id is null`,
    #88) does not bypass `event_logs_session_idx`, as #117 supposed it did:
    a btree indexes NULL, and Postgres scans `IS NULL` as an index
    condition on the leading column. So the journal read is a BitmapOr of
    two scans on the one index the baseline ships, and the partial index
    #117 proposed would be a second copy of the same access path.

    This is the EXPLAIN that establishes it. The planner is told to price a
    sequential scan out (`set local enable_seqscan = off`) because on a
    test-sized table it would otherwise, correctly, just read the heap;
    what is under test is which index is *eligible* for the `is null` arm,
    not what wins on ten rows. The statement is the store's own
    (`RECENT_EVENTS_SQL`), not a copy, so the assertion follows the query
    if the query moves."""
    from app.store import RECENT_EVENTS_SQL, PostgresStore

    url = pgharness.pg_url()
    pgharness.apply_migrations(url)
    pgharness.truncate_all(url)

    async def flow():
        store = PostgresStore(url)
        s = await store.create_session("norad-terminal", "leased-9600", None)
        for i in range(5):
            await store.log_event(s.id, "input", "user", {"n": i})
            await store.log_event(None, "route", "system", {"n": i})

        pool = await store._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute("set local enable_seqscan = off")
            rows = await conn.fetch("explain " + RECENT_EVENTS_SQL, uuid.UUID(s.id), 10)
        plan = "\n".join(r[0] for r in rows)
        store._pool = None

        assert "Seq Scan" not in plan, plan
        assert "Index Cond: (session_id IS NULL)" in plan, plan
        scans = re.findall(r"Index Scan on (\w+)", plan)
        assert scans and set(scans) == {"event_logs_session_idx"}, plan

    asyncio.run(flow())
