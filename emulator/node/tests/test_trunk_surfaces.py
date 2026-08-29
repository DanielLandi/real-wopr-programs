"""The machine ends of a machine-to-machine call.

A call between two hosts is not a special code path: each end mints an
ordinary bridge session and dials an ordinary `/link`
(relay/src/local-leg.ts's `openLocalLeg`). `trunk-call` is the end that
ANSWERED, `trunk-caller` the end that PLACED. Both therefore have to be
surfaces this bridge will mint for — and until this suite existed neither
was, so `POST /api/session` answered 400 for both and every machine call
died as a `NO CARRIER` a few milliseconds after the ring. The relay's tests
could not see it: they stub the bridge with a handler that 201s any body.

The second half is about who speaks first. The end that PLACED the call is
the one with something to say — nobody is sitting at it — and in this
feature the caller is Joshua ringing David back. So a `trunk-caller`
session greets on connect with the film's backdoor greeting and is behind
the front door from that moment, rather than presenting `LOGON:` to a
person who was rung.
"""
from __future__ import annotations

import json
import threading

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.joshua import ScriptedJoshua
from app.main import create_app
from app.router import BACKDOOR_GREETING, LOGON_REJECTION
from app.store import MemoryStore


@pytest.fixture()
def client():
    # The engine is pinned to the scripted one so the conversation below is
    # deterministic: `create_app` would otherwise register the Lisp processor
    # whenever its binary happens to be built in this checkout.
    app = create_app(settings=Settings(), store=MemoryStore(),
                     engines={"scripted": ScriptedJoshua({})})
    return TestClient(app)


def user_input(message: str) -> str:
    return json.dumps({"v": 1, "session": "test", "seq": 0, "kind": "input",
                       "link": "client", "payload": message, "eom": True})


def next_output(ws, timeout_s: float = 10.0) -> str:
    """The next `output` envelope, skipping the per-turn `prompt` echo.

    Bounded, on a daemon thread, because the regression this suite guards
    against is a session that says NOTHING on connect: a bare
    `ws.receive_text()` against that blocks forever, and a CI job that hangs
    reports nothing at all. A daemon thread is what lets the interpreter
    still exit while the abandoned read sits in the portal.
    """
    box: list = []

    def pump() -> None:
        while True:
            frame = json.loads(ws.receive_text())
            if frame.get("kind") != "prompt":
                box.append(frame["payload"])
                return

    t = threading.Thread(target=pump, daemon=True)
    t.start()
    t.join(timeout_s)
    assert box, f"no output frame within {timeout_s}s — the session said nothing"
    return box[0]


# -- C2: the two machine surfaces exist at all ------------------------------

@pytest.mark.parametrize("surface,profile", [
    ("trunk-call", "dialup-1200"),
    ("trunk-caller", "off"),
])
def test_a_machine_surface_mints_a_session(client, surface, profile):
    """Without this the whole machine end of a call is a 400.

    The profiles mirror relay/src/config.ts's `surface_links`: a call is
    paced once, by the end that ANSWERED, and the end that placed it must
    not shape as well.
    """
    r = client.post("/api/session", json={"surface": surface})
    assert r.status_code == 201, r.text
    assert r.json()["link_profile"] == profile


# -- C3: the end that placed the call is the one that speaks ----------------

def open_session(client, surface: str):
    body = client.post("/api/session", json={"surface": surface}).json()
    return client.websocket_connect(
        f"/ws/session/{body['session_id']}?token={body['token']}")


def test_a_placed_call_greets_as_joshua_on_connect(client):
    with open_session(client, "trunk-caller") as ws:
        assert BACKDOOR_GREETING in next_output(ws)


def test_a_greeted_caller_holds_an_ordinary_conversation(client):
    """The greeting is worthless if the next line is refused.

    Printing BACKDOOR_GREETING alone would leave the session at the front
    door, so the first thing the answering seat typed would come back
    --CONNECTION TERMINATED--. The greeting and the attachment are one act
    (`Router.open_backdoor`), and this is the half that proves it.
    """
    with open_session(client, "trunk-caller") as ws:
        assert BACKDOOR_GREETING in next_output(ws)
        ws.send_text(user_input("HELLO"))
        reply = next_output(ws)
        assert LOGON_REJECTION not in reply
        # The scripted engine's beat after the greeting (fidelity-notes.md
        # §1) — proof the seeded history took, not merely that some text
        # came back.
        assert "HOW ARE YOU FEELING TODAY?" in reply
        ws.send_text(user_input("FINE"))
        assert LOGON_REJECTION not in next_output(ws)


def test_an_answered_call_still_knocks(client):
    """`trunk-call` is a call this host ANSWERED: the far end dialled in and
    gets no more courtesy than any other visitor. Only the end that PLACED
    the call speaks first."""
    with open_session(client, "trunk-call") as ws:
        ws.send_text(user_input("HELLO"))
        assert LOGON_REJECTION in next_output(ws)
