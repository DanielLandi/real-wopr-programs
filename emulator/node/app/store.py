"""State store — the bridge owns ALL DB access (design.md §3.1, deployment.md D4).

Implementations behind one protocol:
- MemoryStore: dev/tests, no external services.
- PostgresStore: plain Postgres (Neon in production) via asyncpg.
"""

from __future__ import annotations

import asyncio
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

from app.wire import STATUSES as WIRE_STATUSES

ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

# Sentinel room key meaning "sessions with room_code is None" — the implicit
# room roomless links form. Never collides with a generated code: real codes
# are exactly 6 chars from ROOM_ALPHABET, this is longer and lowercase-marked
# by its underscores. Defined here (not imported from rooms.py) because
# get_latest_game's room-scoping is a store concern; rooms.py's room_key()
# happens to coin the same literal for lock keys, which is a coincidence of
# naming, not a shared dependency.
GLOBAL_ROOM_KEY = "__global__"

# The enumerations the schema enforces with CHECK constraints (db/migrations),
# as the bridge knows them. Each is the Python copy of a SQL list; the SQL is
# what Postgres enforces, and when the two drift the failure is a 500 in
# production only — #73, where `sessions.surface` listed three surfaces and
# `DEFAULT_LINKS` six. tests/test_check_constraints.py pins every pair against
# the migrations as text, and tests/test_store_contract.py writes every value
# through PostgresStore. MemoryStore refuses anything outside these sets so
# the in-memory suite fails where Postgres would (#91).
EVENT_KINDS = frozenset({"input", "route", "core", "joshua", "error"})
EVENT_ACTORS = frozenset({"user", "wopr", "joshua", "system"})
# The wire's STATUS vocabulary plus QUIT, which no program emits: the bridge
# writes it itself when the operator quits a game (router.py).
GAME_STATUSES = frozenset(WIRE_STATUSES) | {"QUIT"}
# The reconstructions of Joshua an exchange may advertise in the phone book.
# `RegisterExchange.joshua` (main.py) restates this as a pydantic Literal.
EXCHANGE_JOSHUAS = frozenset({"claude", "period"})


def normalize_room_code(code: str) -> str:
    c = code.strip().upper()
    if len(c) != 6 or any(ch not in ROOM_ALPHABET for ch in c):
        raise ValueError("malformed room code")
    return c


def _as_uuid(value: str) -> str | None:
    """None for strings Postgres would reject for a uuid cast — a malformed
    id is just an unknown id (MemoryStore parity). Routes pass raw caller
    strings straight through to the store (session_id path params, WS
    session_id), so PostgresStore must not let asyncpg's DataError on
    `$1::uuid` turn a bad id into a 500 where MemoryStore would quietly
    return None/[]/"" or no-op."""
    try:
        return str(uuid.UUID(value))
    except (ValueError, AttributeError, TypeError):
        return None


def _new_room_code() -> str:
    return "".join(secrets.choice(ROOM_ALPHABET) for _ in range(6))


@dataclass
class Room:
    code: str
    created_at: str
    last_seen_at: str


@dataclass
class Session:
    id: str
    surface: str
    link_profile: str
    defcon: int = 5
    user_id: str | None = None
    last_seen_at: str = ""
    room_code: str | None = None
    system_id: str | None = None


@dataclass
class GameState:
    session_id: str
    game_id: str
    state: str
    status: str
    turn: int = 0
    # Which reconstruction of the title wrote this STATE (games.md §8). STATE
    # is not portable across interpretations, so every resume — including
    # after a host restart — must run this one. "core" covers flat slots.
    interpretation: str = "core"
    # Update recency stamp — the ordering key for get_latest_game in BOTH
    # stores (PostgresStore's `updated_at` column; MemoryStore stamps it in
    # upsert_game). Dev and prod must pick the same "latest" game.
    updated_at: str = ""


class Store(Protocol):
    async def create_session(self, surface: str, link_profile: str, user_id: str | None,
                             room_code: str | None = None, system_id: str | None = None) -> Session: ...
    async def get_session(self, session_id: str) -> Session | None: ...
    async def set_defcon(self, session_id: str, level: int) -> None: ...
    async def get_clearance_level(self, user_id: str | None) -> int: ...
    async def set_operator(self, session_id: str, callsign: str, level: int) -> None: ...
    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        """The journal one session can read back: its own rows plus the
        exchange's — rows logged with `session_id=None`, which belong to the
        installation rather than to any one line (a peer registering, a
        machine calling in). Oldest first, the newest `limit` rows. The
        exchange's rows are the same from every session that reads them;
        another session's rows are never among them (E10)."""
        ...
    async def get_active_game(self, session_id: str) -> GameState | None: ...
    async def get_latest_game(self, game_id: str | None, room_code: str | None = None,
                              playing_only: bool = True) -> GameState | None: ...
    async def upsert_game(self, gs: GameState) -> None: ...
    async def log_event(self, session_id: str | None, kind: str, actor: str, payload: dict[str, Any]) -> None: ...
    async def create_room(self, code: str | None = None) -> Room: ...
    async def get_room(self, code: str) -> Room | None: ...
    async def touch_room(self, code: str) -> None: ...
    async def get_system_state(self, session_id: str) -> str: ...
    async def set_system_state(self, session_id: str, state: str) -> None: ...
    async def list_exchanges(self) -> list[dict[str, Any]]: ...
    async def register_exchange(self, id: str, name: str, region: str, api: str,
                                link: str, joshua: str, operator: str | None) -> bool: ...


class MemoryStore:
    """In-memory Store for dev and tests. Same contract as PostgresStore."""

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.games: dict[str, GameState] = {}  # keyed by session_id (latest game only)
        self.events: list[dict[str, Any]] = []
        self.clearances: dict[str, int] = {}
        self.rooms: dict[str, Room] = {}
        self.system_states: dict[str, str] = {}
        self.exchanges: dict[str, dict[str, Any]] = {}

    async def create_session(self, surface: str, link_profile: str, user_id: str | None,
                             room_code: str | None = None, system_id: str | None = None) -> Session:
        s = Session(
            id=str(uuid.uuid4()),
            surface=surface,
            link_profile=link_profile,
            user_id=user_id,
            last_seen_at=datetime.now(timezone.utc).isoformat(),
            room_code=room_code,
            system_id=system_id,
        )
        self.sessions[s.id] = s
        return s

    async def get_session(self, session_id: str) -> Session | None:
        return self.sessions.get(session_id)

    async def set_defcon(self, session_id: str, level: int) -> None:
        # Unknown id: no-op, matching PostgresStore's guarded update
        # affecting zero rows (also the malformed-id case there).
        if session_id in self.sessions:
            self.sessions[session_id].defcon = level

    async def get_clearance_level(self, user_id: str | None) -> int:
        if user_id is None:
            return 5  # anonymous: may only "command" DEFCON 5, i.e. nothing
        return self.clearances.get(user_id, 5)

    async def set_operator(self, session_id: str, callsign: str, level: int) -> None:
        # Unknown id: no-op entirely, including the clearance write — parity
        # with PostgresStore, where the session update and the clearance
        # upsert share one transaction and a malformed/unknown id aborts it
        # before either statement lands.
        if session_id not in self.sessions:
            return
        self.sessions[session_id].user_id = callsign
        self.clearances[callsign] = level

    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        # Unknown id: no rows, not even the exchange's own — parity with
        # PostgresStore's malformed-id guard (the nearest thing it has).
        if session_id not in self.sessions:
            return []
        rows = [e for e in self.events
                if e["session_id"] == session_id or e["session_id"] is None]
        return rows[-limit:]

    async def get_active_game(self, session_id: str) -> GameState | None:
        gs = self.games.get(session_id)
        return gs if gs and gs.status == "PLAYING" else None

    async def get_latest_game(self, game_id: str | None, room_code: str | None = None,
                              playing_only: bool = True) -> GameState | None:
        """Most recent PLAYING game of `game_id` across sessions — the Big
        Board observes whatever simulation is running (surfaces.md
        cross-surface notes). `game_id=None` means any game; `room_code`
        scopes the lookup to sessions in that room. `room_code=GLOBAL_ROOM_KEY`
        scopes to sessions with no room (`room_code is None`) — the implicit
        room roomless links form; `room_code=None` means no scoping at all.
        `playing_only=False` also matches finished games, so observers can
        render a war's terminal frame instead of losing sight of it.

        Ordered by `updated_at` — PostgresStore parity (its query orders by the
        `updated_at` column); the stable sort breaks equal stamps toward the
        most recent upsert (dict order tracks re-insertion)."""
        ordered = sorted(self.games.values(), key=lambda g: g.updated_at)
        for gs in reversed(ordered):
            if game_id is not None and gs.game_id != game_id:
                continue
            if playing_only and gs.status != "PLAYING":
                continue
            if room_code is not None:
                sess = self.sessions.get(gs.session_id)
                if sess is None:
                    continue
                if room_code == GLOBAL_ROOM_KEY:
                    if sess.room_code is not None:
                        continue
                elif sess.room_code != room_code:
                    continue
            return gs
        return None

    async def upsert_game(self, gs: GameState) -> None:
        # Stamp update recency — get_latest_game orders by it (PostgresStore
        # writes `updated_at: now()`; the two stores must agree). Re-insert so
        # dict order tracks recency too: the tie-breaker for equal stamps.
        if gs.status not in GAME_STATUSES:
            raise ValueError(f"game status {gs.status!r} violates game_states.status CHECK")
        gs.updated_at = datetime.now(timezone.utc).isoformat()
        self.games.pop(gs.session_id, None)
        self.games[gs.session_id] = gs

    async def log_event(self, session_id: str | None, kind: str, actor: str, payload: dict[str, Any]) -> None:
        # What PostgresStore's CHECK constraints would refuse, refused here too,
        # so a new kind or actor cannot pass the in-memory suite and fail in Neon.
        if kind not in EVENT_KINDS:
            raise ValueError(f"event kind {kind!r} violates event_logs.kind CHECK")
        if actor not in EVENT_ACTORS:
            raise ValueError(f"event actor {actor!r} violates event_logs.actor CHECK")
        self.events.append(
            {"session_id": session_id, "kind": kind, "actor": actor, "payload": payload,
             "ts": datetime.now(timezone.utc).isoformat()}
        )

    async def create_room(self, code: str | None = None) -> Room:
        if code is None:
            code = _new_room_code()
            while code in self.rooms:  # regenerate on collision (generated codes only)
                code = _new_room_code()
        else:
            # Explicit code: return existing room unchanged (idempotent)
            if code in self.rooms:
                return self.rooms[code]
        now = datetime.now(timezone.utc).isoformat()
        room = Room(code=code, created_at=now, last_seen_at=now)
        self.rooms[room.code] = room
        return room

    async def get_room(self, code: str) -> Room | None:
        return self.rooms.get(code)

    async def touch_room(self, code: str) -> None:
        if code in self.rooms:
            self.rooms[code].last_seen_at = datetime.now(timezone.utc).isoformat()

    async def get_system_state(self, session_id: str) -> str:
        return self.system_states.get(session_id, "")

    async def set_system_state(self, session_id: str, state: str) -> None:
        self.system_states[session_id] = state

    async def list_exchanges(self) -> list[dict[str, Any]]:
        return [
            {k: e[k] for k in ("id", "name", "region", "api", "link", "joshua", "operator")}
            for e in self.exchanges.values() if e["approved"]
        ]

    async def register_exchange(self, id: str, name: str, region: str, api: str,
                                link: str, joshua: str, operator: str | None) -> bool:
        if joshua not in EXCHANGE_JOSHUAS:
            raise ValueError(f"joshua {joshua!r} violates exchanges.joshua CHECK")
        if id in self.exchanges:
            return False
        self.exchanges[id] = {"id": id, "name": name, "region": region,
                              "api": api, "link": link, "joshua": joshua,
                              "operator": operator, "approved": False}
        return True


#: The journal read behind `PostgresStore.get_recent_events`: a session's own
#: rows plus the exchange's (`session_id is null`, #88) under one limit. Named
#: so tests/test_store_contract.py can EXPLAIN the exact statement the store
#: runs — the `is null` arm is served by `event_logs_session_idx` (a btree
#: indexes NULL and scans `IS NULL` as an index condition), which is why #117's
#: proposed partial index on the null rows was not added.
RECENT_EVENTS_SQL = (
    "select session_id, ts, kind, actor, payload from event_logs"
    " where session_id = $1::uuid or session_id is null"
    " order by ts desc, id desc limit $2")


class PostgresStore:
    """Plain Postgres (Neon in production) via asyncpg.

    The pool is created lazily on first use: create_app() is sync, so there
    is no async construction point. asyncpg is imported lazily so the
    in-memory dev/test path never needs it ([prod] extra only).
    DB column operator_callsign <-> Session.user_id (roster callsign).
    """

    def __init__(self, database_url: str) -> None:
        self._url = database_url
        self._pool = None
        self._pool_guard: asyncio.Lock | None = None

    async def _pool_or_connect(self):
        if self._pool is not None:
            return self._pool
        if self._pool_guard is None:
            self._pool_guard = asyncio.Lock()
        async with self._pool_guard:
            if self._pool is None:
                import asyncpg  # lazy on purpose: optional [prod] dependency
                import json

                async def _init(conn):
                    await conn.set_type_codec(
                        "jsonb", encoder=json.dumps, decoder=json.loads,
                        schema="pg_catalog")

                self._pool = await asyncpg.create_pool(
                    self._url, min_size=0, max_size=5, init=_init,
                    # Neon's pooled endpoint sits behind PgBouncer in
                    # transaction mode, which does not preserve server-side
                    # prepared statements across pooled connections; asyncpg's
                    # per-connection statement cache then intermittently
                    # collides (DuplicatePreparedStatementError). Disabling it
                    # is the documented workaround.
                    statement_cache_size=0)
        return self._pool

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()
            self._pool = None

    @staticmethod
    def _session_from(row) -> Session:
        return Session(
            id=str(row["id"]), surface=row["surface"],
            link_profile=row["link_profile"], defcon=row["defcon"],
            user_id=row["operator_callsign"],
            last_seen_at=row["last_seen_at"].isoformat(),
            room_code=row["room_code"], system_id=row["system_id"],
        )

    @staticmethod
    def _game_from(row) -> GameState:
        return GameState(
            session_id=str(row["session_id"]), game_id=row["game_id"],
            state=row["state"], status=row["status"], turn=row["turn"],
            interpretation=row["interpretation"],
            updated_at=row["updated_at"].isoformat(),
        )

    async def create_session(self, surface: str, link_profile: str,
                             user_id: str | None, room_code: str | None = None,
                             system_id: str | None = None) -> Session:
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(
            "insert into sessions (surface, link_profile, operator_callsign,"
            " room_code, system_id) values ($1,$2,$3,$4,$5) returning *",
            surface, link_profile, user_id, room_code, system_id)
        return self._session_from(row)

    async def get_session(self, session_id: str) -> Session | None:
        uid = _as_uuid(session_id)
        if uid is None:  # malformed id is just an unknown id (MemoryStore parity)
            return None
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(
            "select * from sessions where id = $1::uuid", uid)
        return self._session_from(row) if row else None

    async def set_defcon(self, session_id: str, level: int) -> None:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: no-op (MemoryStore parity)
            return
        pool = await self._pool_or_connect()
        await pool.execute(
            "update sessions set defcon = $2, last_seen_at = now()"
            " where id = $1::uuid", uid, level)

    async def get_clearance_level(self, user_id: str | None) -> int:
        if user_id is None:
            return 5
        pool = await self._pool_or_connect()
        level = await pool.fetchval(
            "select level from operator_clearances where callsign = $1", user_id)
        return level if level is not None else 5

    async def set_operator(self, session_id: str, callsign: str, level: int) -> None:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: no-op the whole transaction (MemoryStore parity)
            return
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "update sessions set operator_callsign = $2 where id = $1::uuid",
                uid, callsign)
            await conn.execute(
                "insert into operator_clearances (callsign, level) values ($1,$2)"
                " on conflict (callsign) do update set level = excluded.level,"
                " updated_at = now()", callsign, level)

    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: no rows (MemoryStore parity)
            return []
        pool = await self._pool_or_connect()
        rows = await pool.fetch(RECENT_EVENTS_SQL, uid, limit)
        out = [{"session_id": None if r["session_id"] is None else str(r["session_id"]),
                "ts": r["ts"].isoformat(),
                "kind": r["kind"], "actor": r["actor"], "payload": r["payload"]}
               for r in rows]
        return list(reversed(out))

    async def log_event(self, session_id: str | None, kind: str, actor: str,
                        payload: dict[str, Any]) -> None:
        uid = None
        if session_id is not None:
            uid = _as_uuid(session_id)
            if uid is None:  # malformed (not merely absent) id: no-op
                return
        pool = await self._pool_or_connect()
        await pool.execute(
            "insert into event_logs (session_id, kind, actor, payload)"
            " values ($1::uuid,$2,$3,$4)", uid, kind, actor, payload)

    async def get_active_game(self, session_id: str) -> GameState | None:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: no active game (MemoryStore parity)
            return None
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(
            "select * from game_states where session_id = $1::uuid and"
            " status = 'PLAYING' order by updated_at desc limit 1", uid)
        return self._game_from(row) if row else None

    async def get_latest_game(self, game_id: str | None,
                              room_code: str | None = None,
                              playing_only: bool = True) -> GameState | None:
        pool = await self._pool_or_connect()
        clauses, args = [], []

        def arg(value):
            args.append(value)
            return f"${len(args)}"

        if playing_only:
            clauses.append("g.status = 'PLAYING'")
        if game_id is not None:
            clauses.append(f"g.game_id = {arg(game_id)}")
        if room_code == GLOBAL_ROOM_KEY:
            clauses.append("s.room_code is null")
        elif room_code is not None:
            clauses.append(f"s.room_code = {arg(room_code)}")
        where = (" where " + " and ".join(clauses)) if clauses else ""
        row = await pool.fetchrow(
            "select g.* from game_states g join sessions s on s.id = g.session_id"
            + where + " order by g.updated_at desc limit 1", *args)
        return self._game_from(row) if row else None

    async def upsert_game(self, gs: GameState) -> None:
        uid = _as_uuid(gs.session_id)
        if uid is None:
            # gs.session_id always comes from a session this store created
            # (routes never let a caller set it directly) — a malformed
            # value cannot happen via any route. Guarded anyway for
            # consistency with every other method taking a session_id;
            # no-op rather than a 500, the same contract the read paths use.
            return
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            updated = await conn.fetchval(
                "update game_states set state=$3, status=$4, turn=$5,"
                " interpretation=$6, updated_at=now() where id = ("
                "  select id from game_states where session_id=$1::uuid and"
                "  game_id=$2 order by updated_at desc limit 1) returning id",
                uid, gs.game_id, gs.state, gs.status, gs.turn,
                gs.interpretation)
            if updated is None:
                await conn.execute(
                    "insert into game_states (session_id, game_id, state,"
                    " status, turn, interpretation) values ($1::uuid,$2,$3,$4,$5,$6)",
                    uid, gs.game_id, gs.state, gs.status, gs.turn,
                    gs.interpretation)

    async def create_room(self, code: str | None = None) -> Room:
        pool = await self._pool_or_connect()
        if code is not None:
            code = normalize_room_code(code)
            row = await pool.fetchrow(
                "insert into rooms (code) values ($1) on conflict (code)"
                " do nothing returning *", code)
            if row is None:  # existed: idempotent, never reset (POST /api/room contract)
                row = await pool.fetchrow("select * from rooms where code = $1", code)
            return Room(code=row["code"], created_at=row["created_at"].isoformat(),
                        last_seen_at=row["last_seen_at"].isoformat())
        for _ in range(16):
            candidate = _new_room_code()
            row = await pool.fetchrow(
                "insert into rooms (code) values ($1) on conflict (code)"
                " do nothing returning *", candidate)
            if row is not None:
                return Room(code=row["code"], created_at=row["created_at"].isoformat(),
                            last_seen_at=row["last_seen_at"].isoformat())
        raise RuntimeError("room code space exhausted")

    async def get_room(self, code: str) -> Room | None:
        pool = await self._pool_or_connect()
        row = await pool.fetchrow("select * from rooms where code = $1", code)
        if row is None:
            return None
        return Room(code=row["code"], created_at=row["created_at"].isoformat(),
                    last_seen_at=row["last_seen_at"].isoformat())

    async def touch_room(self, code: str) -> None:
        pool = await self._pool_or_connect()
        await pool.execute(
            "update rooms set last_seen_at = now() where code = $1", code)

    async def get_system_state(self, session_id: str) -> str:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: default state (MemoryStore parity)
            return ""
        pool = await self._pool_or_connect()
        state = await pool.fetchval(
            "select state from session_system_state where session_id = $1::uuid",
            uid)
        return state if state is not None else ""

    async def set_system_state(self, session_id: str, state: str) -> None:
        uid = _as_uuid(session_id)
        if uid is None:  # unknown id: no-op (MemoryStore parity)
            return
        pool = await self._pool_or_connect()
        await pool.execute(
            "insert into session_system_state (session_id, state) values"
            " ($1::uuid,$2) on conflict (session_id) do update set"
            " state = excluded.state, updated_at = now()", uid, state)

    async def list_exchanges(self) -> list[dict[str, Any]]:
        pool = await self._pool_or_connect()
        rows = await pool.fetch(
            "select id, name, region, api, link, joshua, operator from exchanges"
            " where approved order by created_at")
        return [dict(r) for r in rows]

    async def register_exchange(self, id: str, name: str, region: str, api: str,
                                link: str, joshua: str, operator: str | None) -> bool:
        pool = await self._pool_or_connect()
        inserted = await pool.fetchval(
            "insert into exchanges (id, name, region, api, link, joshua, operator)"
            " values ($1,$2,$3,$4,$5,$6,$7) on conflict (id) do nothing returning id",
            id, name, region, api, link, joshua, operator)
        return inserted is not None


def make_store(database_url: str) -> Store:
    """DATABASE_URL set => PostgresStore; empty => MemoryStore (dev/tests)."""
    if database_url:
        return PostgresStore(database_url)
    return MemoryStore()
