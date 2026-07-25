"""SupabaseStore logic tests against a faked PostgREST client (no cloud —
there is no live Supabase; prod runs the in-memory store today, so these
pin the behavior #35 will go live with).

The fake implements exactly the fluent surface the store uses —
table().select/insert/update, .eq/.is_/.in_/.order/.limit, .execute().data —
plus a UNIQUE(code) constraint on rooms so duplicate-insert paths are real
(db/migrations/0002_exchanges.sql declares that constraint).
"""

import asyncio
import itertools

import pytest

from app.store import GLOBAL_ROOM_KEY, SupabaseStore


class FakeAPIError(Exception):
    """Stands in for postgrest's APIError on a constraint violation."""


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, db, table):
        self._db, self._table = db, table
        self._filters = []
        self._order, self._desc, self._limit = None, False, None
        self._op = ("select", None)

    def select(self, _cols="*"):
        self._op = ("select", None)
        return self

    def insert(self, values):
        self._op = ("insert", dict(values))
        return self

    def update(self, values):
        self._op = ("update", dict(values))
        return self

    def eq(self, col, val):
        self._filters.append(lambda r: r.get(col) == val)
        return self

    def is_(self, col, val):
        assert val == "null"
        self._filters.append(lambda r: r.get(col) is None)
        return self

    def in_(self, col, vals):
        vals = list(vals)
        self._filters.append(lambda r: r.get(col) in vals)
        return self

    def order(self, col, desc=False):
        self._order, self._desc = col, desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        rows = self._db.tables.setdefault(self._table, [])
        kind, values = self._op
        if kind == "insert":
            row = dict(values)
            row.setdefault("id", f"row-{next(self._db.seq)}")
            row.setdefault("created_at", "2026-01-01T00:00:00+00:00")
            row.setdefault("last_seen_at", "2026-01-01T00:00:00+00:00")
            if self._table == "rooms" and any(r["code"] == row["code"] for r in rows):
                raise FakeAPIError(
                    'duplicate key value violates unique constraint "rooms_code_key"')
            rows.append(row)
            return _Result([dict(row)])
        matched = [r for r in rows if all(f(r) for f in self._filters)]
        if kind == "update":
            for r in matched:
                r.update(values)
            return _Result([dict(r) for r in matched])
        if self._order is not None:
            matched = sorted(matched, key=lambda r: r[self._order], reverse=self._desc)
        if self._limit is not None:
            matched = matched[: self._limit]
        return _Result([dict(r) for r in matched])


class FakeClient:
    def __init__(self):
        self.tables: dict[str, list[dict]] = {}
        self.seq = itertools.count(1)

    def table(self, name):
        return _Query(self, name)


class InsertFailsClient(FakeClient):
    """Every rooms insert fails with a NON-duplicate error (connection reset)."""

    def table(self, name):
        q = super().table(name)
        if name == "rooms":
            orig = q.execute

            def execute():
                if q._op[0] == "insert":
                    raise FakeAPIError("connection reset by peer")
                return orig()

            q.execute = execute
        return q


def make_store(client=None) -> SupabaseStore:
    store = SupabaseStore.__new__(SupabaseStore)  # bypass create_client
    store._client = client or FakeClient()
    return store


def _session_row(sid, room_code):
    return {"id": sid, "surface": "norad-terminal", "link_profile": "leased-9600",
            "defcon": 5, "user_id": None, "last_seen_at": "2026-01-01T00:00:00+00:00",
            "room_code": room_code, "system_id": None}


def _game_row(sid, state, updated_at, status="PLAYING", game_id="gtw"):
    return {"id": f"g-{sid}", "session_id": sid, "game_id": game_id, "state": state,
            "status": status, "turn": 1, "updated_at": updated_at}


# -- create_room (#34: duplicate code must not 500) ---------------------------

def test_create_room_explicit_duplicate_returns_existing():
    """POST /api/room promises idempotency for explicit codes; a duplicate
    insert (explicit-code race) must return the existing room, not raise."""
    client = FakeClient()
    client.tables["rooms"] = [{"code": "AAAAAA", "created_at": "2020-01-01T00:00:00+00:00",
                               "last_seen_at": "2020-01-01T00:00:00+00:00"}]
    store = make_store(client)

    room = asyncio.run(store.create_room("AAAAAA"))
    assert room.code == "AAAAAA"
    assert room.created_at == "2020-01-01T00:00:00+00:00"  # existing, not reset
    assert len(client.tables["rooms"]) == 1


def test_create_room_generated_collision_retries(monkeypatch):
    """A generated-code collision draws a fresh code (MemoryStore's collision
    loop, ported): the caller gets a room, never a 500."""
    client = FakeClient()
    client.tables["rooms"] = [{"code": "AAAAAA", "created_at": "2020-01-01T00:00:00+00:00",
                               "last_seen_at": "2020-01-01T00:00:00+00:00"}]
    store = make_store(client)
    codes = iter(["AAAAAA", "BBBBBB"])
    monkeypatch.setattr("app.store._new_room_code", lambda: next(codes))

    room = asyncio.run(store.create_room())
    assert room.code == "BBBBBB"
    assert len(client.tables["rooms"]) == 2


def test_create_room_non_duplicate_failure_reraises():
    """Only duplicate-code failures are absorbed; a real fault still raises."""
    store = make_store(InsertFailsClient())
    with pytest.raises(FakeAPIError):
        asyncio.run(store.create_room("CCCCCC"))


# -- get_latest_game room scoping (#34: no fixed global window) ---------------

def test_room_scoped_latest_game_survives_busy_other_rooms():
    """>20 newer PLAYING games in other rooms must not make an older room's
    game invisible: the lookup is room-scoped, not a global LIMIT-N scan."""
    client = FakeClient()
    client.tables["sessions"] = [_session_row("s-old", "AAAAAA")] + [
        _session_row(f"s-{i}", "BBBBBB") for i in range(25)
    ]
    client.tables["game_states"] = [
        _game_row("s-old", "OLD ROOM A", "2026-01-01T00:00:00+00:00")
    ] + [
        _game_row(f"s-{i}", f"B{i}", f"2026-01-02T00:00:{i:02d}+00:00") for i in range(25)
    ]
    store = make_store(client)

    game = asyncio.run(store.get_latest_game("gtw", "AAAAAA"))
    assert game is not None
    assert game.state == "OLD ROOM A"


def test_global_room_key_scopes_to_roomless_sessions():
    client = FakeClient()
    client.tables["sessions"] = [_session_row("s-roomed", "AAAAAA"),
                                 _session_row("s-roomless", None)]
    client.tables["game_states"] = [
        _game_row("s-roomed", "ROOMED", "2026-01-02T00:00:00+00:00"),
        _game_row("s-roomless", "ROOMLESS", "2026-01-01T00:00:00+00:00"),
    ]
    store = make_store(client)

    game = asyncio.run(store.get_latest_game("gtw", GLOBAL_ROOM_KEY))
    assert game is not None and game.state == "ROOMLESS"


def test_room_scoped_latest_game_empty_room_is_none():
    client = FakeClient()
    client.tables["sessions"] = []
    client.tables["game_states"] = []
    store = make_store(client)
    assert asyncio.run(store.get_latest_game("gtw", "AAAAAA")) is None


# -- get_latest_game any-status (#43 parity with MemoryStore) -----------------

def test_latest_game_any_status_returns_terminal_game():
    client = FakeClient()
    client.tables["sessions"] = [_session_row("s1", "AAAAAA")]
    client.tables["game_states"] = [
        _game_row("s1", "FINAL", "2026-01-01T00:00:00+00:00", status="NO-WIN"),
    ]
    store = make_store(client)

    assert asyncio.run(store.get_latest_game("gtw", "AAAAAA")) is None
    done = asyncio.run(store.get_latest_game("gtw", "AAAAAA", playing_only=False))
    assert done is not None and done.status == "NO-WIN" and done.state == "FINAL"


def test_supabase_set_operator_is_not_implemented():
    store = make_store()
    with pytest.raises(NotImplementedError):
        asyncio.run(store.set_operator("sid", "NORAD-3", 3))
