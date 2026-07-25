"""One GTW ticker per room. Replaces the per-connection observe_gtw loop,
which advanced the shared simulation once per observer socket (double-advance)
and raced the player's moves. Ticks run under the same RoomLocks the router
uses, so a room's game has exactly one writer at a time."""

from __future__ import annotations

import asyncio
import logging

from .gtwfeed import feed_line
from .rooms import RoomLocks, room_key
from .runner import CoreBusy, CoreError, CoreRunner, CoreTimeout
from .store import GLOBAL_ROOM_KEY, GameState, Store

log = logging.getLogger("wopr.gtwhub")


class GtwRoomHub:
    def __init__(self, store: Store, runner: CoreRunner, catalog: dict,
                 locks: RoomLocks, interval_s: float = 2.5, idle_grace_s: float = 5.0) -> None:
        self.store = store
        self.runner = runner
        self.catalog = catalog
        self.locks = locks
        self.interval_s = interval_s
        self.idle_grace_s = idle_grace_s
        self._subs: dict[str, set[asyncio.Queue[str]]] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._last_status: dict[str, str] = {}

    async def subscribe(self, room_code: str | None):
        key = room_key(room_code)
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=8)
        self._subs.setdefault(key, set()).add(q)
        if key not in self._tasks:
            self._tasks[key] = asyncio.create_task(self._tick_loop(key, room_code))
        try:
            while True:
                yield await q.get()
        finally:
            self._subs[key].discard(q)

    async def _tick_loop(self, key: str, room_code: str | None) -> None:
        idle = 0.0
        try:
            while True:
                if not self._subs.get(key):
                    idle += self.interval_s
                    if idle >= self.idle_grace_s:
                        return
                    await asyncio.sleep(self.interval_s)
                    continue
                idle = 0.0
                line = await self._tick_once(key, room_code)
                if line is not None:
                    for q in list(self._subs.get(key, ())):
                        if q.full():          # slow consumer: drop oldest frame
                            try:
                                q.get_nowait()
                            except asyncio.QueueEmpty:
                                pass
                        q.put_nowait(line)
                await asyncio.sleep(self.interval_s)
        finally:
            # Teardown prunes ALL per-room bookkeeping, not just the task —
            # otherwise _subs/_last_status grow one entry per dead room (#44).
            # Keep a _subs entry only if a new subscriber raced in ahead of us.
            self._tasks.pop(key, None)
            self._last_status.pop(key, None)
            if not self._subs.get(key):
                self._subs.pop(key, None)

    async def _tick_once(self, key: str, room_code: str | None) -> str | None:
        # A roomless subscriber's ticks must only ever see roomless games —
        # GLOBAL_ROOM_KEY scopes the lookup to sessions with room_code=None,
        # not "any playing game" (that would double-advance a roomed war
        # under both its own room lock and the __global__ lock).
        lookup_room = room_code if room_code is not None else GLOBAL_ROOM_KEY
        try:
            async with self.locks.lock(key):
                game = await self.store.get_latest_game("gtw", lookup_room)
                if game is not None:
                    resp = await self.runner.run("gtw", "MOVE", game.state, None,
                                                 timeout_s=self.catalog["gtw"].timeout_s)
                    await self.store.upsert_game(GameState(
                        session_id=game.session_id, game_id="gtw", state=resp.state,
                        status=resp.status, turn=game.turn + 1))
                    status = resp.status
                else:
                    # No live war. If the room's latest war just ended (a
                    # player move can flip it terminal between ticks), keep
                    # serving its terminal frame — QUERY renders the state
                    # without advancing it, and nothing is upserted — so the
                    # board shows NO-WIN/the montage instead of freezing on
                    # the last mid-war frame.
                    game = await self.store.get_latest_game("gtw", lookup_room,
                                                            playing_only=False)
                    if game is None:
                        return None
                    resp = await self.runner.run("gtw", "QUERY", game.state, None,
                                                 timeout_s=self.catalog["gtw"].timeout_s)
                    status = game.status
        except (CoreBusy, CoreTimeout, CoreError) as exc:
            log.info("gtw tick skipped (%s): %s", key, type(exc).__name__)
            return None
        except Exception:                     # never let a store fault kill the room
            log.exception("gtw tick failed (%s)", key)
            return None
        if status != self._last_status.get(key):   # log transitions, not ticks
            self._last_status[key] = status
            await self.store.log_event(game.session_id, "core", "system",
                                       {"game": "gtw", "event": "observe-tick",
                                        "status": status, "room": key})
        return feed_line(resp.display, status)
