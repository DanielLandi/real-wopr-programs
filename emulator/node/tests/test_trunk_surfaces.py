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

Which is exactly why the third part exists (#74). A surface that is behind
the front door on connect, at profile `off`, must not be mintable by a
browser: `POST /api/session` authenticates nobody, so until this guard the
two machine surfaces were a pre-authenticated, unpaced session anyone could
curl. The guard is scoped to those two surfaces and nothing else — every
visitor surface still mints with no header at all, and that is the half of
this suite that a mistake here would take the live site down over.
"""
from __future__ import annotations

import json
import threading

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.joshua import ScriptedJoshua
from app.main import DEFAULT_LINKS, INTERNAL_SURFACES, create_app
from app.router import BACKDOOR_GREETING, LOGON_REJECTION
from app.store import MemoryStore

# The relay holds this as BRIDGE_INTERNAL_TOKEN; it is the same value on both
# services in a deployment.
TOKEN = "test-internal-token"
AUTH = {"x-wopr-internal-token": TOKEN}


def build_client(internal_token: str = TOKEN) -> TestClient:
    # The engine is pinned to the scripted one so the conversation below is
    # deterministic: `create_app` would otherwise register the Lisp processor
    # whenever its binary happens to be built in this checkout. The token is
    # passed explicitly rather than left to `Settings()`'s environment read,
    # so this suite says the same thing on a dev box that exports one.
    app = create_app(settings=Settings(internal_token=internal_token),
                     store=MemoryStore(),
                     engines={"scripted": ScriptedJoshua({})})
    return TestClient(app)


@pytest.fixture()
def client():
    return build_client()


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
    r = client.post("/api/session", json={"surface": surface}, headers=AUTH)
    assert r.status_code == 201, r.text
    assert r.json()["link_profile"] == profile


# -- C3: the end that placed the call is the one that speaks ----------------

def open_session(client, surface: str):
    body = client.post("/api/session", json={"surface": surface},
                       headers=AUTH).json()
    # The same header on the WS: with an internal token configured, the D3
    # guard on `/ws/session/{id}` wants it too, and the comms layer is the
    # only caller of either.
    return client.websocket_connect(
        f"/ws/session/{body['session_id']}?token={body['token']}", headers=AUTH)


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


# -- #74: the machine surfaces are internal ---------------------------------
#
# `POST /api/session` authenticates nobody, deliberately: every visitor
# surface is one a stranger is supposed to be able to open. The two machine
# surfaces are not, and they are the two that skip the front door and the
# pacing. So the guard is scoped to them, and the first four tests below are
# the ones that matter — a guard that also catches a browser is an outage.

VISITOR_SURFACES = sorted(set(DEFAULT_LINKS) - INTERNAL_SURFACES)


@pytest.mark.parametrize("surface", VISITOR_SURFACES)
def test_a_visitor_surface_still_mints_with_no_header_at_all(client, surface):
    """The required test. Every browser that dials realwopr.ai mints here,
    cross-origin, with no credential to offer; if this fails the site is
    down for everyone."""
    r = client.post("/api/session", json={"surface": surface})
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("surface", VISITOR_SURFACES)
def test_a_visitor_surface_ignores_the_header_rather_than_checking_it(client, surface):
    """Present, absent or garbage, the header must not change what a visitor
    surface does. The rule is "these two surfaces require it", not "this
    header must be valid wherever it appears" — a stray proxy header must
    never become a 401 on the front door."""
    r = client.post("/api/session", json={"surface": surface},
                    headers={"x-wopr-internal-token": "not-the-token"})
    assert r.status_code == 201, r.text


@pytest.mark.parametrize("surface", sorted(INTERNAL_SURFACES))
def test_a_machine_surface_refuses_a_caller_with_no_header(client, surface):
    """The exposure this suite's third part exists for: until the guard,
    `curl -X POST .../api/session -d '{"surface":"trunk-caller"}'` answered
    201 and landed the caller behind the front door at baud 0."""
    r = client.post("/api/session", json={"surface": surface})
    assert r.status_code == 401, r.text


@pytest.mark.parametrize("surface", sorted(INTERNAL_SURFACES))
def test_a_machine_surface_refuses_a_wrong_token(client, surface):
    r = client.post("/api/session", json={"surface": surface},
                    headers={"x-wopr-internal-token": TOKEN + "x"})
    assert r.status_code == 401, r.text


@pytest.mark.parametrize("surface", sorted(INTERNAL_SURFACES))
def test_a_machine_surface_survives_a_non_ascii_header(client, surface):
    """A public endpoint must not be turned into a 500 by a header value.

    Sent as raw bytes, which is what a client that is not httpx can put on
    the wire; starlette decodes headers as latin-1, so the app sees a
    non-ASCII `str` and `compare_digest` would raise TypeError on it.
    Comparing UTF-8 bytes instead is what makes this a 401.
    """
    r = client.post("/api/session", json={"surface": surface},
                    headers={"x-wopr-internal-token": "t\u00f6ken".encode()})
    assert r.status_code == 401, r.text


@pytest.mark.parametrize("surface", sorted(INTERNAL_SURFACES))
def test_an_unconfigured_bridge_refuses_the_machine_surfaces_outright(surface):
    """Fail closed, and say exactly what a bogus surface is told.

    With no BRIDGE_INTERNAL_TOKEN there is no header any caller could send
    that would be right, so an exchange that never configured one behaves as
    it did before the trunk surfaces existed: they do not. Unlike the
    `/ws/session` guard, which can afford to fail open because it still
    verifies an HMAC session token, this endpoint has no second factor.
    """
    client = build_client(internal_token="")
    r = client.post("/api/session", json={"surface": surface}, headers=AUTH)
    bogus = client.post("/api/session", json={"surface": "no-such-surface"})
    assert r.status_code == 400, r.text
    # Byte-identical: an unconfigured deployment discloses nothing about its
    # own configuration.
    assert r.json() == bogus.json()


def test_every_trunk_surface_is_declared_internal():
    """The likely mistake is adding a third machine surface to DEFAULT_LINKS
    and forgetting the guard. The set is named rather than inferred from a
    prefix (a machine surface need not be called `trunk-anything`), so this
    checks the other direction and fails in CI instead of production."""
    unguarded = {s for s in DEFAULT_LINKS if s.startswith("trunk-")} - INTERNAL_SURFACES
    assert not unguarded, (
        f"these trunk surfaces mint without the internal token: {sorted(unguarded)} "
        f"— add them to INTERNAL_SURFACES in app/main.py"
    )


def test_the_internal_surfaces_are_all_mintable_surfaces():
    """A guard naming a surface `DEFAULT_LINKS` does not have would be dead
    text pretending to be protection."""
    assert INTERNAL_SURFACES <= set(DEFAULT_LINKS)


def test_a_refused_mint_creates_no_room(client):
    """A refusal has no side effects — the same rule the system/room checks
    already follow. The guard runs before room creation, so an unauthorised
    caller cannot manufacture rooms by naming one."""
    r = client.post("/api/session",
                    json={"surface": "trunk-call", "room_code": "ABCDEF"})
    assert r.status_code == 401, r.text
    assert client.get("/api/room/ABCDEF").status_code == 404


# -- #80: the surface the relay paces by is the one stored here -------------
#
# `/link` used to take the surface from its query string, so a visitor could
# mint an ordinary `home-terminal` session — which needs no token, and must
# not, it is the front door — and then dial `?surface=trunk-caller` to be
# paced at profile `off`. The relay now asks this bridge which surface the
# session actually is, and refuses a dial that claims another. The field it
# reads is `GET /api/session/{id}`'s `surface`, which makes that field a
# cross-service contract rather than a convenience.


@pytest.mark.parametrize("surface", sorted(DEFAULT_LINKS))
def test_a_session_reports_the_surface_it_was_minted_with(client, surface):
    """The relay's `/link` cross-check (#80) is built on this answer.

    Parametrised over every mintable surface, machine ends included: the
    machine legs dial `/link` exactly as a visitor does, so they are
    cross-checked by the same lookup and would be the loudest possible
    breakage if this field ever stopped agreeing with the mint.
    """
    minted = client.post("/api/session", json={"surface": surface}, headers=AUTH)
    assert minted.status_code == 201, minted.text
    r = client.get(f"/api/session/{minted.json()['session_id']}")
    assert r.status_code == 200, r.text
    assert r.json()["surface"] == surface


def test_a_session_that_does_not_exist_is_a_404_not_a_guess(client):
    """The relay reads a 404 as "unknown session" and refuses the dial with
    its own code. An empty body or a defaulted surface here would turn a
    stale session id into a paced line."""
    assert client.get("/api/session/11111111-1111-1111-1111-111111111111"
                      ).status_code == 404
