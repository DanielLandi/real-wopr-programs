import asyncio
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.store import MemoryStore
from app.systems import load_systems
from app.systemrunner import SystemRunner, SystemRunnerConfig
from app.systemwire import SystemResponse

REPO = Path(__file__).resolve().parent.parent.parent.parent
SYS_DIR = REPO / "systems"
REF_BIN = SYS_DIR / "reference" / "harness" / "bin" / "reference"
AIRLINE_BIN = SYS_DIR / "airline" / "harness" / "bin" / "airline"
SCHOOL_BIN = SYS_DIR / "school" / "harness" / "bin" / "school"
PROTOVISION_BIN = SYS_DIR / "protovision" / "harness" / "bin" / "protovision"
PACTEL_BIN = SYS_DIR / "pactel" / "harness" / "bin" / "pactel"

needs_reference = pytest.mark.skipif(
    not REF_BIN.exists(), reason="reference not built (run tools/import-programs.sh)"
)
needs_airline = pytest.mark.skipif(
    not AIRLINE_BIN.exists(), reason="airline not built (run tools/import-programs.sh)"
)
needs_school = pytest.mark.skipif(
    not SCHOOL_BIN.exists(), reason="school not built (run tools/import-programs.sh)"
)
needs_protovision = pytest.mark.skipif(
    not PROTOVISION_BIN.exists(), reason="protovision not built (run tools/import-programs.sh)"
)
needs_pactel = pytest.mark.skipif(
    not PACTEL_BIN.exists(), reason="pactel not built (run tools/import-programs.sh)"
)


def test_load_systems_reads_reference():
    systems = load_systems(SYS_DIR)
    assert "reference" in systems
    assert systems["reference"].language == "cobol"
    assert systems["reference"].number == "(311) 555-0101"


@needs_reference
def test_connect_then_echo_then_bye():
    runner = SystemRunner(SystemRunnerConfig(systems_dir=SYS_DIR))

    async def flow():
        g = await runner.run("reference", "CONNECT", None, None)
        assert g.line == "UP"
        assert "REFERENCE SYSTEM READY" in g.display
        assert g.state == "0"
        e = await runner.run("reference", "INPUT", g.state, "PING")
        assert e.line == "UP"
        assert e.display == "[1] YOU SAID: PING"
        assert e.state == "1"
        b = await runner.run("reference", "INPUT", e.state, "BYE")
        assert b.line == "DROP"

    asyncio.run(flow())


@pytest.fixture()
def system_client():
    # Settings() defaults point systems_dir/internal_token at the real repo
    # systems/ dir and an empty token, same as tests/test_api.py's
    # `client` fixture — the reference system is registered via its checked-in
    # manifest.json regardless of build status; @needs_reference gates the
    # tests that actually invoke its binary.
    return TestClient(create_app(settings=Settings(), store=MemoryStore()))


@needs_reference
def test_ws_system_session_connects_and_echoes(system_client):
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "reference"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        greeting = ws.receive_text()
        assert "REFERENCE SYSTEM READY" in greeting
        ws.send_text('{"v":1,"kind":"input","payload":"PING","eom":true}')
        echo = ws.receive_text()
        assert "[1] YOU SAID: PING" in echo
        ws.send_text('{"v":1,"kind":"input","payload":"BYE","eom":true}')
        # GOODBYE (the system's own display) followed by NO CARRIER, then close.
        assert "GOODBYE" in ws.receive_text()
        assert "NO CARRIER" in ws.receive_text()


def test_ws_system_connect_error_is_clean_no_carrier(system_client, tmp_path):
    # A connect-time system failure (here: a missing binary — the runner's
    # systems_dir is repointed at an empty dir so binary_for yields a
    # non-existent path -> SystemFault) must degrade to NO CARRIER + a clean
    # close, never an unhandled exception tearing down the socket. `reference`
    # stays in the registry so the session still binds; only the binary is gone.
    system_client.app.state.system_runner.cfg.systems_dir = tmp_path
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "reference"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "NO CARRIER" in ws.receive_text()
    # Exiting the context manager without raising == the socket closed cleanly.


@needs_reference
def test_non_ascii_input_does_not_raise():
    # A non-ASCII user line must not raise UnicodeEncodeError out of the runner
    # (which would escape ws_session): it is encoded errors="replace", so the
    # accented char becomes '?' and the line stays up with a normal response.
    runner = SystemRunner(SystemRunnerConfig(systems_dir=SYS_DIR))

    async def flow():
        g = await runner.run("reference", "CONNECT", None, None)
        e = await runner.run("reference", "INPUT", g.state, "café")
        assert e.line == "UP"
        assert "YOU SAID:" in e.display  # replaced bytes, but a clean response

    asyncio.run(flow())


@needs_airline
def test_ws_system_session_dials_airline_and_books_paris(system_client):
    # The home terminal's "PAN AM / PANAMAC" dial (Rung 3, Task 2) — same WS
    # path as any exchange dial, just bound to system: "airline" instead of
    # a room. Drives the film-baseline Paris booking (S9) end to end through
    # the real COBOL PANAMAC binary built in Task 1.
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "airline"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        greeting = ws.receive_text()
        assert "PANAMAC" in greeting

        ws.send_text('{"v":1,"kind":"input","payload":"AJFKPAR","eom":true}')
        avail = ws.receive_text()
        assert "AVAILABILITY" in avail
        assert "PA 002" in avail

        ws.send_text('{"v":1,"kind":"input","payload":"02Y1","eom":true}')
        assert "SEGMENT ADDED" in ws.receive_text()

        ws.send_text('{"v":1,"kind":"input","payload":"-LIGHTMAN/DAVID","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"-MACK/JENNIFER","eom":true}')
        ws.receive_text()

        ws.send_text('{"v":1,"kind":"input","payload":"E","eom":true}')
        end = ws.receive_text()
        assert "RECORD LOCATOR:" in end
        m = re.search(r"RECORD LOCATOR:\s*([A-Z0-9]{6})", end)
        assert m is not None, end


@needs_school
def test_ws_system_session_dials_school_and_changes_grade(system_client):
    # The home terminal's "GOOSE LAKE" dial (Rung 4) — same WS path as the
    # airline, bound to system: "school". Drives the S2 grade change F->A
    # through the real bwBASIC program built in Task 1.
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "school"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "PASSWORD:" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"PENCIL","eom":true}')
        assert "SELECT:" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"2","eom":true}')
        assert "STUDENT NAME:" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"LIGHTMAN","eom":true}')
        assert "COURSE:" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"BIOLOGY 2","eom":true}')
        assert "NEW GRADE:" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"A","eom":true}')
        assert "RECORD UPDATED." in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"1","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"LIGHTMAN","eom":true}')
        shown = ws.receive_text()
        # Same-line check: BIOLOGY 2 specifically must now read A. A bare
        # `" A" in shown` would pass on LIGHTMAN's pre-existing COMPUTER LAB A
        # even if the F->A change silently failed — this proves the STATE
        # carryover, matching the 16-col padded wire form in
        # systems/school/tests/10-verify-show.out ("BIOLOGY 2       A").
        assert re.search(r"BIOLOGY 2\s+A\b", shown), shown  # F->A persisted through STATE, not the pre-existing COMPUTER LAB A


@needs_protovision
def test_ws_system_session_dials_protovision_and_queues(system_client):
    # The home terminal's PROTOVISION dial — same WS path as the airline/school,
    # bound to system: "protovision". Drives the dev-BBS queue round-trip through
    # the real 6502 program built in Task 1.
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "protovision"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "PROTOVISION" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"L","eom":true}')
        listing = ws.receive_text()
        assert "ZYPHON" in listing and "* VELDRAX" in listing
        ws.send_text('{"v":1,"kind":"input","payload":"Q 1","eom":true}')
        assert "QUEUED: ZYPHON" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"Q","eom":true}')
        shown = ws.receive_text()
        assert "YOUR QUEUE:" in shown and "ZYPHON" in shown  # persisted via STATE


# -- bridge parity for system sessions (#58) ---------------------------------

def test_session_rejects_system_plus_room_code(system_client):
    """`system` and `room_code` together must 400: a system-bound session
    never enters the router/room paths, so accepting both silently
    manufactures an inert room (#58). No room may be created either."""
    r = system_client.post("/api/session", json={
        "surface": "home-terminal", "system": "reference", "room_code": "CCCCCC"})
    assert r.status_code == 400
    assert system_client.get("/api/room/CCCCCC").status_code == 404


async def _scripted_system_run(self, system_id, command, state, user_input, timeout_s=None,
                               reply=None):
    """Class-level SystemRunner.run replacement (no binary needed): a turn
    counter in STATE, 'NOP' answers DISPLAY 0, 'BYE' drops the line."""
    turn = int(state) + 1 if state else 1
    if command == "CONNECT":
        return SystemResponse(system_id, "0", "FAKE SYSTEM READY", "UP")
    if user_input == "NOP":
        return SystemResponse(system_id, str(turn), "", "UP")
    if user_input == "BYE":
        return SystemResponse(system_id, str(turn), "GOODBYE", "DROP")
    return SystemResponse(system_id, str(turn), f"ECHO {user_input}", "UP")


def test_system_turns_are_logged_to_event_logs(monkeypatch):
    """The router path logs input+route rows per turn; system sessions must
    have the same event-log parity, not be invisible in history (#58)."""
    monkeypatch.setattr(SystemRunner, "run", _scripted_system_run)
    store = MemoryStore()
    client = TestClient(create_app(settings=Settings(), store=store))
    r = client.post("/api/session", json={"surface": "home-terminal", "system": "reference"})
    sid, token = r.json()["session_id"], r.json()["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "FAKE SYSTEM READY" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"HELLO","eom":true}')
        assert "ECHO HELLO" in ws.receive_text()

    inputs = [e for e in store.events if e["kind"] == "input" and e["actor"] == "user"]
    routes = [e for e in store.events if e["kind"] == "route" and e["actor"] == "system"]
    assert any(e["payload"].get("text") == "HELLO" for e in inputs)
    assert any(e["payload"].get("input") == "HELLO"
               and e["payload"].get("system") == "reference" for e in routes)


def test_empty_display_sends_no_blank_frame(monkeypatch):
    """DISPLAY 0 must not paint a blank '\\n\\n' frame on the teletype; the
    STATE still persists so the session's turn counter advances (#58)."""
    monkeypatch.setattr(SystemRunner, "run", _scripted_system_run)
    store = MemoryStore()
    client = TestClient(create_app(settings=Settings(), store=store))
    r = client.post("/api/session", json={"surface": "home-terminal", "system": "reference"})
    sid, token = r.json()["session_id"], r.json()["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "FAKE SYSTEM READY" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"NOP","eom":true}')   # DISPLAY 0
        ws.send_text('{"v":1,"kind":"input","payload":"HELLO","eom":true}')
        # The very next frame is HELLO's echo — no blank frame in between.
        assert "ECHO HELLO" in ws.receive_text()

    assert asyncio.run(store.get_system_state(sid)) == "2"  # NOP's STATE persisted


@needs_pactel
def test_ws_system_session_dials_pactel_and_verifies_line(system_client):
    # The home terminal's PACIFIC TELEPHONE dial — same WS path as the other
    # systems, bound to system: "pactel". Drives the test-board line round-trip
    # through the real C binary built in Task 1.
    r = system_client.post("/api/session", json={"surface": "home-terminal", "system": "pactel"})
    assert r.status_code == 201
    sid, token = r.json()["session_id"], r.json()["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "PACIFIC TELEPHONE" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"ANAC","eom":true}')
        assert "206 555 0137" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"LINE 2065551234","eom":true}')
        assert "206 555 1234" in ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"VERIFY","eom":true}')
        shown = ws.receive_text()
        assert "206 555 1234" in shown and "IDLE" in shown  # selected line persisted via STATE


def test_a_store_with_no_number_is_not_in_the_dial_in_registry():
    """school-db lives on the local bus; nothing should be able to dial it."""
    systems = load_systems(SYS_DIR)
    assert "school-db" in {p.parent.name for p in SYS_DIR.glob("*/harness")}
    assert "school-db" not in systems
    assert "school" in systems


def test_two_sessions_do_not_share_a_store(system_client):
    """The monolith serves strangers on one box. If it shared a store, the
    first visitor to change David's biology grade would change it for everyone
    who dialled in afterwards — and the film's moment only works if each
    visitor finds the F themselves."""
    def grade_for(session_json):
        sid, token = session_json["session_id"], session_json["token"]
        with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
            ws.receive_text()                                    # PASSWORD:
            ws.send_text('{"v":1,"kind":"input","payload":"PENCIL","eom":true}')
            ws.receive_text()                                    # menu
            ws.send_text('{"v":1,"kind":"input","payload":"1","eom":true}')
            ws.receive_text()                                    # STUDENT NAME:
            ws.send_text('{"v":1,"kind":"input","payload":"LIGHTMAN","eom":true}')
            return ws.receive_text()

    first = system_client.post("/api/session",
                               json={"surface": "home-terminal", "system": "school"}).json()
    sid, token = first["session_id"], first["token"]
    with system_client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"PENCIL","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"2","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"LIGHTMAN","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"BIOLOGY 2","eom":true}')
        ws.receive_text()
        ws.send_text('{"v":1,"kind":"input","payload":"A","eom":true}')
        assert "RECORD UPDATED." in ws.receive_text()

    # A different visitor entirely.
    second = system_client.post("/api/session",
                                json={"surface": "home-terminal", "system": "school"}).json()
    assert re.search(r"BIOLOGY 2\s+F", grade_for(second)), "the store leaked between sessions"
