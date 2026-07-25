"""Per-room serialization. One lock per room key: the router's core moves and
the GTW hub's ticks both acquire it, so a room's game advances one writer at a
time (multiplayer-rooms spec, 'one game per room')."""

from __future__ import annotations

import asyncio


def room_key(room_code: str | None) -> str:
    return room_code or "__global__"


class RoomLocks:
    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def lock(self, key: str) -> asyncio.Lock:
        return self._locks.setdefault(key, asyncio.Lock())
