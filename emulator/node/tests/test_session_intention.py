"""The seat handle in, the intention out, and the call at the hangup.

These tests are about WHEN a call is placed, not about HTTP — place_seat_call
is stubbed throughout. Task 5's tests own the request itself.

The call is placed in the session's `finally`, at the hangup, never at the
moment the dossier is disclosed: a seat on a call is held, and a held seat
is refused `busy` (relay/src/seats.ts:187), so a call placed while the
visitor is still on the line would be refused every time. The tests below
pin that ordering, the latch behaviour (one intention per session, however
many times it is re-triggered), the no-handle and no-intention no-ops, and
that a failure in placement never breaks the disconnect path itself.

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

    Monkeypatches app.main.place_seat_call so any call the session places
    appends its handle to `placed_calls`, instead of reaching HTTP.
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


@pytest.fixture()
def refuse_calls(monkeypatch):
    """Make the monkeypatched place_seat_call raise instead of succeeding.

    Must be requested after `session_ws` (fixture args do not order this;
    pytest resolves `session_ws` first because it is listed first in the
    test's own signature), so this replacement lands on top of the fake
    installed by that fixture.
    """
    def setter(exc: BaseException):
        async def fake_place_seat_call(trunk_url, internal_token, handle, *, timeout_s=5.0):
            raise exc

        monkeypatch.setattr(main_module, "place_seat_call", fake_place_seat_call, raising=False)

    return setter


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


def test_the_call_is_placed_at_the_hangup_not_at_the_dossier(session_ws, placed_calls):
    """A seat on a call is held, and a held seat is refused `busy`. Placing
    at the moment of intention would fail every time (spec §2)."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        assert FALKEN_DOSSIER in ws.receive_json()["payload"]
        assert placed_calls == [], "placed while the visitor was still on the line"
    assert placed_calls == ["HANDLE1"]


def test_no_intention_places_nothing(session_ws, placed_calls):
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("HELLO"))
        ws.receive_json()
    assert placed_calls == []


def test_no_handle_places_nothing(session_ws, placed_calls):
    """A visitor who dialled without a seat token cannot be rung back, and
    the intention is dropped rather than guessed at."""
    with session_ws() as ws:
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    assert placed_calls == []


def test_the_intention_is_a_latch_not_a_counter(session_ws, placed_calls):
    """Two dossier disclosures in one session are one intention. A machine
    that rings twice for one decision is a machine with a bug."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        for _ in range(2):
            ws.send_json(user_input("IS FALKEN DEAD?"))
            ws.receive_json()
    assert placed_calls == ["HANDLE1"]


def test_a_refusal_does_not_break_the_hangup(session_ws, placed_calls, refuse_calls):
    """The callback runs in `finally`, during teardown. A failure there must
    be a callback that did not happen, never a session that did not close."""
    refuse_calls(RuntimeError("hub exploded"))
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    # Reaching here at all is the assertion: the context manager exited
    # cleanly rather than propagating out of the disconnect path.
