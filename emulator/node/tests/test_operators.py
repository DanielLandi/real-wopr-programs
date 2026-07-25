"""Operator roster parsing (WOPR_OPERATORS) — the interim identity source
for the norad-terminal operator tier (spec 2026-07-20, D4 amendment)."""

import pytest

from app.operators import Operator, parse_roster


def test_parse_roster_happy_path():
    roster = parse_roster("NORAD-3:TIGERTEAM:3,NORAD-1:CRYSTALPALACE:1")
    assert roster == {
        "NORAD-3": Operator("NORAD-3", "TIGERTEAM", 3),
        "NORAD-1": Operator("NORAD-1", "CRYSTALPALACE", 1),
    }


def test_parse_roster_empty_and_whitespace():
    assert parse_roster("") == {}
    assert parse_roster(" , ") == {}


def test_parse_roster_malformed_fails_fast():
    for bad in ("NORAD-3", "NORAD-3:CODE", "NORAD-3:CODE:9",
                "NORAD-3:CODE:0", "norad-3:code:3", "A:B:C"):
        with pytest.raises(ValueError):
            parse_roster(bad)


def test_parse_roster_malformed_redacts_access_code():
    # Verify that access codes are redacted from error messages to prevent
    # credential leaks in deploy logs/tracebacks (startup parsing).
    with pytest.raises(ValueError) as exc:
        parse_roster("NORAD-3:SECRETCODE")
    error_msg = str(exc.value)
    assert "SECRETCODE" not in error_msg
    assert "NORAD-3" in error_msg  # but callsign is still visible for debugging


def test_parse_roster_reserved_and_duplicate_rejected():
    with pytest.raises(ValueError):
        parse_roster("JOSHUA:CODE:1")  # can never shadow the backdoor
    with pytest.raises(ValueError):
        parse_roster("NORAD-3:A1:3,NORAD-3:B2:2")


import asyncio

from app.store import MemoryStore


def test_memory_store_set_operator_stamps_session_and_clearance():
    store = MemoryStore()

    async def flow():
        s = await store.create_session("norad-terminal", "leased-9600", None)
        await store.set_operator(s.id, "NORAD-3", 3)
        fresh = await store.get_session(s.id)
        assert fresh.user_id == "NORAD-3"
        assert await store.get_clearance_level("NORAD-3") == 3

    asyncio.run(flow())


def test_memory_store_recent_events_scoped_and_bounded():
    store = MemoryStore()

    async def flow():
        a = await store.create_session("norad-terminal", "leased-9600", None)
        b = await store.create_session("home-terminal", "dialup-300", None)
        for i in range(12):
            await store.log_event(a.id, "input", "user", {"text": str(i)})
        await store.log_event(b.id, "input", "user", {"text": "other"})
        rows = await store.get_recent_events(a.id, limit=10)
        assert len(rows) == 10
        assert rows[0]["payload"]["text"] == "2"   # oldest kept
        assert rows[-1]["payload"]["text"] == "11"  # newest last
        assert all(r["session_id"] == a.id for r in rows)

    asyncio.run(flow())
