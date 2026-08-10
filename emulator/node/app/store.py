"""State store — the bridge owns ALL DB access (design.md §3.1, deployment.md D4).

Implementations behind one protocol:
- MemoryStore: dev/tests, no external services.
- PostgresStore: plain Postgres (Neon in production) via asyncpg.
- SupabaseStore: hosted Supabase via the service-role key (server-side only).
  Superseded by PostgresStore; retained until Task 6 removes it.
"""

from __future__ import annotations

import asyncio
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Protocol

ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

# Sentinel room key meaning "sessions with room_code is None" — the implicit
# room roomless links form. Never collides with a generated code: real codes
# are exactly 6 chars from ROOM_ALPHABET, this is longer and lowercase-marked
# by its underscores. Defined here (not imported from rooms.py) because
# get_latest_game's room-scoping is a store concern; rooms.py's room_key()
# happens to coin the same literal for lock keys, which is a coincidence of
# naming, not a shared dependency.
GLOBAL_ROOM_KEY = "__global__"


def normalize_room_code(code: str) -> str:
    c = code.strip().upper()
    if len(c) != 6 or any(ch not in ROOM_ALPHABET for ch in c):
        raise ValueError("malformed room code")
    return c


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
    # stores (SupabaseStore's `updated_at` column; MemoryStore stamps it in
    # upsert_game). Dev and prod must pick the same "latest" game.
    updated_at: str = ""


class Store(Protocol):
    async def create_session(self, surface: str, link_profile: str, user_id: str | None,
                             room_code: str | None = None, system_id: str | None = None) -> Session: ...
    async def get_session(self, session_id: str) -> Session | None: ...
    async def set_defcon(self, session_id: str, level: int) -> None: ...
    async def get_clearance_level(self, user_id: str | None) -> int: ...
    async def set_operator(self, session_id: str, callsign: str, level: int) -> None: ...
    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]: ...
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


class MemoryStore:
    """In-memory Store for dev and tests. Same contract as SupabaseStore."""

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self.games: dict[str, GameState] = {}  # keyed by session_id (latest game only)
        self.events: list[dict[str, Any]] = []
        self.clearances: dict[str, int] = {}
        self.rooms: dict[str, Room] = {}
        self.system_states: dict[str, str] = {}

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
        self.sessions[session_id].defcon = level

    async def get_clearance_level(self, user_id: str | None) -> int:
        if user_id is None:
            return 5  # anonymous: may only "command" DEFCON 5, i.e. nothing
        return self.clearances.get(user_id, 5)

    async def set_operator(self, session_id: str, callsign: str, level: int) -> None:
        self.sessions[session_id].user_id = callsign
        self.clearances[callsign] = level

    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        rows = [e for e in self.events if e["session_id"] == session_id]
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

        Ordered by `updated_at` — Supabase parity (its query orders by the
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
        # Stamp update recency — get_latest_game orders by it (SupabaseStore
        # writes `updated_at: now()`; the two stores must agree). Re-insert so
        # dict order tracks recency too: the tie-breaker for equal stamps.
        gs.updated_at = datetime.now(timezone.utc).isoformat()
        self.games.pop(gs.session_id, None)
        self.games[gs.session_id] = gs

    async def log_event(self, session_id: str | None, kind: str, actor: str, payload: dict[str, Any]) -> None:
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
                    self._url, min_size=0, max_size=5, init=_init)
        return self._pool

    async def close(self) -> None:
        if self._pool is not None:
            pool, self._pool = self._pool, None
            try:
                await pool.close()
            except RuntimeError as exc:
                # asyncpg pools are bound to the event loop that created
                # them. In production (main.py's lifespan) the pool is
                # created and closed under the same loop and this never
                # fires. The store-contract fixture, by its documented
                # "async def flow(); asyncio.run(flow())" convention (see
                # tests/test_gtw.py), creates the pool lazily inside a
                # test's own asyncio.run() and tears it down in a separate
                # asyncio.run() in fixture teardown — a different, already-
                # closed loop by the time close() runs. asyncpg then can't
                # gracefully terminate the old connection and raises this
                # exact error; it's a test-harness artifact, not a real
                # leak (the old loop already tore down its transports), so
                # only this specific message is swallowed.
                if "Event loop is closed" not in str(exc):
                    raise

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
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(
            "select * from sessions where id = $1::uuid", session_id)
        return self._session_from(row) if row else None

    async def set_defcon(self, session_id: str, level: int) -> None:
        pool = await self._pool_or_connect()
        await pool.execute(
            "update sessions set defcon = $2, last_seen_at = now()"
            " where id = $1::uuid", session_id, level)

    async def get_clearance_level(self, user_id: str | None) -> int:
        if user_id is None:
            return 5
        pool = await self._pool_or_connect()
        level = await pool.fetchval(
            "select level from operator_clearances where callsign = $1", user_id)
        return level if level is not None else 5

    async def set_operator(self, session_id: str, callsign: str, level: int) -> None:
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            await conn.execute(
                "update sessions set operator_callsign = $2 where id = $1::uuid",
                session_id, callsign)
            await conn.execute(
                "insert into operator_clearances (callsign, level) values ($1,$2)"
                " on conflict (callsign) do update set level = excluded.level,"
                " updated_at = now()", callsign, level)

    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        pool = await self._pool_or_connect()
        rows = await pool.fetch(
            "select session_id, ts, kind, actor, payload from event_logs"
            " where session_id = $1::uuid order by ts desc, id desc limit $2",
            session_id, limit)
        out = [{"session_id": str(r["session_id"]), "ts": r["ts"].isoformat(),
                "kind": r["kind"], "actor": r["actor"], "payload": r["payload"]}
               for r in rows]
        return list(reversed(out))

    async def log_event(self, session_id: str | None, kind: str, actor: str,
                        payload: dict[str, Any]) -> None:
        pool = await self._pool_or_connect()
        await pool.execute(
            "insert into event_logs (session_id, kind, actor, payload)"
            " values ($1::uuid,$2,$3,$4)", session_id, kind, actor, payload)

    async def get_active_game(self, session_id: str) -> GameState | None:
        pool = await self._pool_or_connect()
        row = await pool.fetchrow(
            "select * from game_states where session_id = $1::uuid and"
            " status = 'PLAYING' order by updated_at desc limit 1", session_id)
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
        pool = await self._pool_or_connect()
        async with pool.acquire() as conn, conn.transaction():
            updated = await conn.fetchval(
                "update game_states set state=$3, status=$4, turn=$5,"
                " interpretation=$6, updated_at=now() where id = ("
                "  select id from game_states where session_id=$1::uuid and"
                "  game_id=$2 order by updated_at desc limit 1) returning id",
                gs.session_id, gs.game_id, gs.state, gs.status, gs.turn,
                gs.interpretation)
            if updated is None:
                await conn.execute(
                    "insert into game_states (session_id, game_id, state,"
                    " status, turn, interpretation) values ($1::uuid,$2,$3,$4,$5,$6)",
                    gs.session_id, gs.game_id, gs.state, gs.status, gs.turn,
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
        pool = await self._pool_or_connect()
        state = await pool.fetchval(
            "select state from session_system_state where session_id = $1::uuid",
            session_id)
        return state if state is not None else ""

    async def set_system_state(self, session_id: str, state: str) -> None:
        pool = await self._pool_or_connect()
        await pool.execute(
            "insert into session_system_state (session_id, state) values"
            " ($1::uuid,$2) on conflict (session_id) do update set"
            " state = excluded.state, updated_at = now()", session_id, state)


class SupabaseStore:
    """Hosted Supabase (D4): service-role key, deny-all RLS for everyone else.

    Lazy import so the bridge runs without the dependency in dev/tests.
    """

    def __init__(self, url: str, service_role_key: str) -> None:
        from supabase import create_client  # imported here on purpose

        self._client = create_client(url, service_role_key)

    async def create_session(self, surface: str, link_profile: str, user_id: str | None,
                             room_code: str | None = None, system_id: str | None = None) -> Session:
        row = (
            self._client.table("sessions")
            .insert({"surface": surface, "link_profile": link_profile, "user_id": user_id,
                     "room_code": room_code, "system_id": system_id})
            .execute()
            .data[0]
        )
        return Session(
            id=row["id"], surface=row["surface"], link_profile=row["link_profile"],
            defcon=row["defcon"], user_id=row["user_id"], last_seen_at=row["last_seen_at"],
            room_code=row.get("room_code"), system_id=row.get("system_id"),
        )

    async def get_session(self, session_id: str) -> Session | None:
        rows = self._client.table("sessions").select("*").eq("id", session_id).execute().data
        if not rows:
            return None
        row = rows[0]
        return Session(
            id=row["id"], surface=row["surface"], link_profile=row["link_profile"],
            defcon=row["defcon"], user_id=row["user_id"], last_seen_at=row["last_seen_at"],
            room_code=row.get("room_code"), system_id=row.get("system_id"),
        )

    async def set_defcon(self, session_id: str, level: int) -> None:
        self._client.table("sessions").update({"defcon": level}).eq("id", session_id).execute()

    async def get_clearance_level(self, user_id: str | None) -> int:
        if user_id is None:
            return 5
        rows = self._client.table("clearances").select("level").eq("user_id", user_id).execute().data
        return rows[0]["level"] if rows else 5

    async def set_operator(self, session_id: str, callsign: str, level: int) -> None:
        # Roster auth is by definition the pre-Supabase identity source: the
        # sessions.user_id column is a uuid FK to auth.users and cannot hold a
        # callsign. With Supabase provisioned, identity comes from Auth JWTs
        # and clearances rows instead (#35/#42).
        raise NotImplementedError("roster auth requires Supabase Auth (#35/#42)")

    async def get_recent_events(self, session_id: str, limit: int = 10) -> list[dict[str, Any]]:
        rows = (self._client.table("event_logs").select("*")
                .eq("session_id", session_id)
                .order("ts", desc=True).limit(limit).execute().data)
        return list(reversed(rows))

    async def get_active_game(self, session_id: str) -> GameState | None:
        rows = (
            self._client.table("game_states").select("*")
            .eq("session_id", session_id).eq("status", "PLAYING")
            .order("updated_at", desc=True).limit(1).execute().data
        )
        if not rows:
            return None
        r = rows[0]
        return GameState(session_id=r["session_id"], game_id=r["game_id"], state=r["state"],
                         status=r["status"], turn=r["turn"],
                         interpretation=r.get("interpretation") or "core",
                         updated_at=r.get("updated_at", ""))

    async def get_latest_game(self, game_id: str | None, room_code: str | None = None,
                              playing_only: bool = True) -> GameState | None:
        query = self._client.table("game_states").select("*")
        if playing_only:
            query = query.eq("status", "PLAYING")
        if game_id is not None:
            query = query.eq("game_id", game_id)
        if room_code is not None:
            # Room-scoped (including GLOBAL_ROOM_KEY): resolve the room's
            # sessions first, then take the newest game among them. Never a
            # fixed global window — a busy exchange elsewhere must not push
            # an older room's game out of visibility (a LIMIT-N scan across
            # every room made the room's war invisible once >N newer games
            # were PLAYING elsewhere, forking duplicate games on NEW).
            sessions = self._client.table("sessions").select("id")
            if room_code == GLOBAL_ROOM_KEY:
                sessions = sessions.is_("room_code", "null")
            else:
                sessions = sessions.eq("room_code", room_code)
            session_ids = [r["id"] for r in sessions.execute().data]
            if not session_ids:
                return None
            query = query.in_("session_id", session_ids)
        rows = query.order("updated_at", desc=True).limit(1).execute().data
        if not rows:
            return None
        r = rows[0]
        return GameState(session_id=r["session_id"], game_id=r["game_id"], state=r["state"],
                         status=r["status"], turn=r["turn"],
                         interpretation=r.get("interpretation") or "core",
                         updated_at=r.get("updated_at", ""))

    async def upsert_game(self, gs: GameState) -> None:
        existing = (
            self._client.table("game_states").select("id")
            .eq("session_id", gs.session_id).eq("game_id", gs.game_id)
            .order("updated_at", desc=True).limit(1).execute().data
        )
        values = {"session_id": gs.session_id, "game_id": gs.game_id, "state": gs.state,
                  "status": gs.status, "turn": gs.turn,
                  "interpretation": gs.interpretation, "updated_at": "now()"}
        if existing:
            self._client.table("game_states").update(values).eq("id", existing[0]["id"]).execute()
        else:
            self._client.table("game_states").insert(values).execute()

    async def log_event(self, session_id: str | None, kind: str, actor: str, payload: dict[str, Any]) -> None:
        self._client.table("event_logs").insert(
            {"session_id": session_id, "kind": kind, "actor": actor, "payload": payload}
        ).execute()

    async def create_room(self, code: str | None = None) -> Room:
        # UNIQUE(code) can reject the insert two ways: an explicit-code race
        # (two sessions naming the same room concurrently) or a generated-code
        # collision (MemoryStore's regenerate loop, ported). Neither may 500:
        # POST /api/room promises idempotent explicit codes. The duplicate is
        # detected behaviorally (does the room now exist?) rather than by
        # exception type, so we stay independent of the client's error classes.
        for _ in range(16):
            candidate = code if code is not None else _new_room_code()
            try:
                row = (
                    self._client.table("rooms")
                    .insert({"code": candidate})
                    .execute()
                    .data[0]
                )
            except Exception:
                existing = await self.get_room(candidate)
                if existing is None:
                    raise  # a real fault, not a duplicate code
                if code is not None:
                    return existing  # idempotent: never recreate/reset a room
                continue  # generated collision: draw a fresh code
            return Room(code=row["code"], created_at=row["created_at"],
                        last_seen_at=row["last_seen_at"])
        raise RuntimeError("could not allocate a unique room code")

    async def get_room(self, code: str) -> Room | None:
        rows = self._client.table("rooms").select("*").eq("code", code).execute().data
        if not rows:
            return None
        row = rows[0]
        return Room(code=row["code"], created_at=row["created_at"], last_seen_at=row["last_seen_at"])

    async def touch_room(self, code: str) -> None:
        self._client.table("rooms").update(
            {"last_seen_at": datetime.now(timezone.utc).isoformat()}
        ).eq("code", code).execute()

    async def get_system_state(self, session_id: str) -> str:
        # Opaque per-session system state, mirroring game_states' shape but
        # keyed 1:1 on session_id (a session binds at most one system).
        rows = (
            self._client.table("session_system_state").select("state")
            .eq("session_id", session_id).execute().data
        )
        return rows[0]["state"] if rows else ""

    async def set_system_state(self, session_id: str, state: str) -> None:
        existing = (
            self._client.table("session_system_state").select("session_id")
            .eq("session_id", session_id).execute().data
        )
        if existing:
            self._client.table("session_system_state").update(
                {"state": state}
            ).eq("session_id", session_id).execute()
        else:
            self._client.table("session_system_state").insert(
                {"session_id": session_id, "state": state}
            ).execute()


def make_store(database_url: str) -> Store:
    """DATABASE_URL set => PostgresStore; empty => MemoryStore (dev/tests)."""
    if database_url:
        return PostgresStore(database_url)
    return MemoryStore()
