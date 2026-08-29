"""The seat handle in, the intention out, and the call at the hangup.

These tests are about WHEN a call is placed, not about HTTP — place_seat_call
is stubbed throughout. Task 5's tests own the request itself.

Two of these tests are deliberately red: `test_origin_seat_records_the_handle`
and `test_origin_world_slot_is_not_a_handle` both assert on `placed_calls`,
and this task (6) only *records* the seat handle — it does not place a call.
That is Task 7's work. Only `test_an_unknown_origin_never_reaches_the_program`
is expected to pass here.

session_ws drives the real `/ws/session/{id}` endpoint through FastAPI's
TestClient (fastapi.testclient.TestClient + websocket_connect), the same
harness test_api.py uses — no parallel machinery. Its `receive_json()`
discards "prompt" frames and hands back the next "output" frame: this suite
is about what Joshua said and who gets called back, not the UI-mode echo
test_api.py already pins turn-by-turn.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from fastapi.testclient import TestClient

import app.main as main_module
from app.config import Settings
from app.joshua import FALKEN_DOSSIER
from app.main import create_app
from app.store import MemoryStore


def control(message: str) -> dict:
    return {"v": 1, "session": "test", "seq": 0, "kind": "control",
            "link": "client", "payload": message, "eom": True}


def user_input(message: str) -> dict:
    return {"v": 1, "session": "test", "seq": 0, "kind": "input",
            "link": "client", "payload": message, "eom": True}


class _Session:
    """Adapter over the raw TestClient websocket session.

    send_json mirrors the raw session's own send_json. receive_json skips
    "prompt" envelopes (the mode echo) and returns the next "output" one —
    what this suite actually cares about.
    """

    def __init__(self, raw):
        self._raw = raw

    def send_json(self, envelope: dict) -> None:
        self._raw.send_text(json.dumps(envelope))

    def receive_json(self) -> dict:
        while True:
            frame = json.loads(self._raw.receive_text())
            if frame.get("kind") != "prompt":
                return frame


@pytest.fixture()
def placed_calls():
    return []


@pytest.fixture()
def session_ws(monkeypatch, placed_calls):
    """A context-manager factory: `with session_ws() as ws: ...`.

    Monkeypatches app.main.place_seat_call so a future call (Task 7's, not
    this task's) would append its handle to `placed_calls` — Task 6 wires
    nothing to it yet, so the list only ever changes once Task 7 does.
    """
    async def fake_place_seat_call(trunk_url, internal_token, handle, *, timeout_s=5.0):
        placed_calls.append(handle)
        return "placed"

    monkeypatch.setattr(main_module, "place_seat_call", fake_place_seat_call, raising=False)

    store = MemoryStore()
    app = create_app(settings=Settings(), store=store)
    client = TestClient(app)

    @contextlib.contextmanager
    def opener():
        body = client.post("/api/session", json={"surface": "home-terminal"}).json()
        sid, token = body["session_id"], body["token"]
        with client.websocket_connect(f"/ws/session/{sid}?token={token}") as raw:
            raw.receive_text()  # the film's LOGON: greeting (fidelity-notes.md §1)
            yield _Session(raw)

    return opener


def test_origin_seat_records_the_handle(session_ws, placed_calls):
    """A handle disclosed at connect is the only way the host can ever ring
    this visitor back."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        assert FALKEN_DOSSIER in ws.receive_json()["payload"]
    assert placed_calls == ["HANDLE1"]


def test_origin_world_slot_is_not_a_handle(session_ws, placed_calls):
    """A machine calling in discloses where it called FROM. That is not a
    seat, and ringing it back would be ringing an exchange, not a person."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN world 1 slot PANAM"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    assert placed_calls == []


def test_an_unknown_origin_never_reaches_the_program(session_ws):
    """The existing drop, pinned. A control frame read as input is a control
    frame a period program will try to execute."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN something we do not know"))
        ws.send_json(user_input("HELLO"))
        reply = ws.receive_json()["payload"]
        assert "something we do not know" not in reply
