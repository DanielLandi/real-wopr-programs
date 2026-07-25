"""State store — the bridge owns ALL DB access (design.md §3.1, deployment.md D4).

Two implementations behind one protocol:
- MemoryStore: dev/tests, no external services.
- SupabaseStore: hosted Supabase via the service-role key (server-side only).
"""

from __future__ import annotations

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
                         updated_at=r.get("updated_at", ""))

    async def upsert_game(self, gs: GameState) -> None:
        existing = (
            self._client.table("game_states").select("id")
            .eq("session_id", gs.session_id).eq("game_id", gs.game_id)
            .order("updated_at", desc=True).limit(1).execute().data
        )
        values = {"session_id": gs.session_id, "game_id": gs.game_id, "state": gs.state,
                  "status": gs.status, "turn": gs.turn, "updated_at": "now()"}
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


def make_store(url: str, service_role_key: str) -> Store:
    if url and service_role_key:
        return SupabaseStore(url, service_role_key)
    return MemoryStore()
