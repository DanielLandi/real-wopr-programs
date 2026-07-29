"""REST + WS contract tests (api-contract.md §2-3, §7) via Starlette TestClient."""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.store import GameState, MemoryStore
from app.wire import CoreResponse

REPO = Path(__file__).resolve().parent.parent.parent.parent
REAL_BIN = REPO / "games"

needs_core = pytest.mark.skipif(
    not (REAL_BIN / "tictactoe" / "harness" / "bin" / "tictactoe").exists(),
    reason="core not built (run tools/import-programs.sh)",
)


@pytest.fixture()
def client():
    store = MemoryStore()
    app = create_app(settings=Settings(), store=store)
    c = TestClient(app)
    c.app_store = store
    return c


def make_session(client, surface="home-terminal"):
    r = client.post("/api/session", json={"surface": surface})
    assert r.status_code == 201
    return r.json()


def test_health(client):
    assert client.get("/health").json()["status"] == "ok"


def test_create_session_returns_token_and_link(client):
    body = make_session(client)
    assert set(body) == {"session_id", "token", "link_profile", "room_code", "system", "joshua"}
    assert body["link_profile"] == "dialup-300"
    assert body["room_code"] is None
    assert body["system"] is None


def test_create_session_unknown_surface_is_400(client):
    assert client.post("/api/session", json={"surface": "toaster"}).status_code == 400


def test_session_can_bind_a_system(client):
    r = client.post("/api/session", json={"surface": "home-terminal", "system": "reference"})
    assert r.status_code == 201
    assert r.json()["system"] == "reference"
    sid = r.json()["session_id"]
    assert client.get(f"/api/session/{sid}").json()["system"] == "reference"


def test_session_rejects_unknown_system(client):
    r = client.post("/api/session", json={"surface": "home-terminal", "system": "nope"})
    assert r.status_code == 400


def test_get_session_and_404(client):
    body = make_session(client, "norad-terminal")
    r = client.get(f"/api/session/{body['session_id']}")
    assert r.status_code == 200
    assert r.json()["surface"] == "norad-terminal"
    assert r.json()["defcon"] == 5
    assert client.get("/api/session/00000000-0000-0000-0000-000000000000").status_code == 404


def test_games_catalog_lists_all_sixteen(client):
    games = client.get("/api/games").json()
    assert len(games) == 16
    byid = {g["id"]: g for g in games}
    assert byid["tictactoe"]["status"] == "implemented"
    # Status mirrors the manifests on disk, so this test never goes stale
    # as catalog placeholders get implemented one PR at a time.
    games_dir = Path(__file__).resolve().parents[3] / "games"
    for gid, g in byid.items():
        expected = "implemented" if (games_dir / gid / "harness" / "manifest.json").exists() else "placeholder"
        assert g["status"] == expected, f"{gid}: {g['status']} != {expected}"


def test_defcon_clearance_gating(client):
    body = make_session(client, "norad-terminal")
    sid = body["session_id"]
    # Anonymous clearance floor is 5: setting 5 is allowed, anything lower 403s.
    assert client.post(f"/api/session/{sid}/defcon", json={"level": 5}).status_code == 200
    assert client.post(f"/api/session/{sid}/defcon", json={"level": 2}).status_code == 403
    # A cleared user may go lower (bridge-side check per deployment.md D4).
    client.app_store.clearances["operator-1"] = 2
    client.app_store.sessions[sid].user_id = "operator-1"
    assert client.post(f"/api/session/{sid}/defcon", json={"level": 2}).status_code == 200
    assert client.post(f"/api/session/{sid}/defcon", json={"level": 1}).status_code == 403
    assert client.get(f"/api/session/{sid}").json()["defcon"] == 2


def test_defcon_validation_is_422(client):
    sid = make_session(client)["session_id"]
    assert client.post(f"/api/session/{sid}/defcon", json={"level": 9}).status_code == 422


class _AlwaysPlayingRunner:
    """Fake CoreRunner: every command reports a PLAYING game, deterministically,
    with no built binary needed — used for WS tests of the OBSERVE GTW gate."""

    async def run(self, game_id, command, state, move, timeout_s=None,
                  interp_dir=None) -> CoreResponse:
        return CoreResponse(game_id=game_id, state=state or "STATE",
                            display="ZULU 00:00  DEFCON 5", status="PLAYING", result=None)


def ws_envelope(session_id, payload, kind="input"):
    return json.dumps({"v": 1, "session": session_id, "seq": 0, "kind": kind,
                       "link": "client", "payload": payload, "eom": True})


def test_ws_rejects_bad_token(client):
    from starlette.websockets import WebSocketDisconnect

    sid = make_session(client)["session_id"]
    # The server closes before accepting; TestClient raises at connect time.
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/session/{sid}?token=forged"):
            pass
    assert exc.value.code == 4401


@needs_core
def test_ws_full_exchange_list_games_and_play(client):
    body = make_session(client)
    sid, token = body["session_id"], body["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        # The system speaks first: the film's LOGON: prompt (fidelity-notes §1).
        greet = json.loads(ws.receive_text())
        assert "LOGON:" in greet["payload"]

        ws.send_text(ws_envelope(sid, "JOSHUA"))
        out = json.loads(ws.receive_text())
        assert "GREETINGS PROFESSOR FALKEN." in out["payload"]
        # The prompt is its own frame, sent after the output frame for the
        # same turn — Tasks 9 and 10 build on that ordering, and this is the
        # only wire-level assertion of it in the suite (test_monitor.py only
        # ever sees RouteResult.prompt, never the envelope). Checking out's
        # kind above and prompt_frame's kind here, in receive order, pins it.
        assert out["kind"] == "output"
        prompt_frame = json.loads(ws.receive_text())
        assert prompt_frame["kind"] == "prompt"
        assert prompt_frame["payload"] == ">"  # attached to Joshua: bare prompt

        ws.send_text(ws_envelope(sid, "LIST GAMES"))
        out = json.loads(ws.receive_text())
        assert out["kind"] == "output" and "GLOBAL THERMONUCLEAR WAR" in out["payload"]
        prompt_frame = json.loads(ws.receive_text())
        assert prompt_frame["kind"] == "prompt"
        # LIST GAMES is a reserved word answered while still attached to
        # Joshua (#T8) — the attachment, and so the prompt, is unchanged.
        assert prompt_frame["payload"] == ">"

        ws.send_text(ws_envelope(sid, "NEW tictactoe"))
        out = json.loads(ws.receive_text())
        assert "TIC-TAC-TOE" in out["payload"]
        prompt_frame = json.loads(ws.receive_text())
        assert prompt_frame["kind"] == "prompt"
        # NEW tictactoe attaches the terminal to the game; tictactoe's
        # manifest abbrev is TTT (games/tictactoe/harness/manifest.json).
        assert prompt_frame["payload"] == "[TTT]>"

        ws.send_text(ws_envelope(sid, "5"))
        out = json.loads(ws.receive_text())
        assert "X" in out["payload"] and "O" in out["payload"]  # WOPR replied


@needs_core
def test_ws_reassembles_chunked_input(client):
    body = make_session(client)
    sid, token = body["session_id"], body["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        json.loads(ws.receive_text())  # LOGON: greeting
        ws.send_text(ws_envelope(sid, "JOSHUA"))
        assert "GREETINGS PROFESSOR FALKEN." in json.loads(ws.receive_text())["payload"]
        prompt_frame = json.loads(ws.receive_text())
        # The only wire-level check here that the mode reaches the client at
        # all: test_monitor.py asserts RouteResult.prompt, never the frame.
        assert prompt_frame["kind"] == "prompt"
        assert prompt_frame["payload"] == ">"  # attached to Joshua: bare prompt
        for i, (chunk, eom) in enumerate([("LIST ", False), ("GAMES", True)]):
            ws.send_text(json.dumps({"v": 1, "session": sid, "seq": i, "kind": "input",
                                     "link": "client", "payload": chunk, "eom": eom}))
        out = json.loads(ws.receive_text())
        assert "FALKEN'S MAZE" in out["payload"]


def test_ws_resync_does_not_regreet_an_authenticated_session(client):
    """A relay resync reconnects the same session (engine repo #54): the LOGON:
    greeting belongs only to a line that hasn't opened the backdoor yet."""
    body = make_session(client)
    sid, token = body["session_id"], body["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "LOGON:" in json.loads(ws.receive_text())["payload"]
        ws.send_text(ws_envelope(sid, "JOSHUA"))
        assert "GREETINGS PROFESSOR FALKEN." in json.loads(ws.receive_text())["payload"]
    # Simulated RESYNC: a new WS connection for the same, still-authenticated
    # session. The first frame must answer our input, not re-prompt LOGON:.
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        ws.send_text(ws_envelope(sid, "HELP GAMES"))
        out = json.loads(ws.receive_text())
        assert "LOGON:" not in out["payload"]
        assert "GLOBAL THERMONUCLEAR WAR" in out["payload"]


def test_ws_fresh_session_still_gets_the_logon_greeting_on_reconnect(client):
    """The counterpart: an UNauthenticated session that reconnects is still
    greeted — suppression keys off the backdoor, not off connection count."""
    body = make_session(client)
    sid, token = body["session_id"], body["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "LOGON:" in json.loads(ws.receive_text())["payload"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        assert "LOGON:" in json.loads(ws.receive_text())["payload"]


def test_ws_greets_an_operator_again_after_a_restart():
    """The greeting and the door must agree. The attachment lives in memory and
    does not survive the process; the store's `user_id` does. Greeting by the
    store while answering from memory left a reconnected operator ungreeted and
    every command answering --CONNECTION TERMINATED--."""
    settings = Settings(wopr_operators="NORAD-3:TIGERTEAM:3")
    store = MemoryStore()  # the store outlives the process; the router does not

    with TestClient(create_app(settings=settings, store=store)) as c:
        body = make_session(c, "norad-terminal")
        sid, token = body["session_id"], body["token"]
        with c.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
            assert "LOGON:" in json.loads(ws.receive_text())["payload"]
            ws.send_text(ws_envelope(sid, "LOGON NORAD-3"))
            assert "ACCESS CODE:" in json.loads(ws.receive_text())["payload"]
            json.loads(ws.receive_text())  # prompt frame
            ws.send_text(ws_envelope(sid, "TIGERTEAM"))
            assert "CLEARANCE ACCEPTED" in json.loads(ws.receive_text())["payload"]

    # Redeploy: a new app over the same store, so user_id survives and the
    # attachment does not.
    with TestClient(create_app(settings=settings, store=store)) as c2:
        with c2.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
            # Type first, then read: an ungreeted line would otherwise leave
            # both ends waiting for the other, and this would hang, not fail.
            ws.send_text(ws_envelope(sid, "SITREP"))
            assert "LOGON:" in json.loads(ws.receive_text())["payload"]
            # ...and the door agrees with the greeting it just gave.
            assert "--CONNECTION TERMINATED--" in json.loads(ws.receive_text())["payload"]


def test_ws_operator_reconnect_in_same_process_is_not_regreeted():
    """The counterpart to the restart case above: a resync *within* the same
    process keeps the router's in-memory attachment, so the door already
    admits the operator's commands. Greeting by `is_authenticated` (which
    only the JOSHUA backdoor sets) would flash a bogus LOGON: here even
    though the door says the operator is in — norad-terminal auto-reconnects
    on every close, so this is a live path, not a hypothetical one."""
    settings = Settings(wopr_operators="NORAD-3:TIGERTEAM:3")
    store = MemoryStore()

    with TestClient(create_app(settings=settings, store=store)) as c:
        body = make_session(c, "norad-terminal")
        sid, token = body["session_id"], body["token"]
        with c.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
            assert "LOGON:" in json.loads(ws.receive_text())["payload"]
            ws.send_text(ws_envelope(sid, "LOGON NORAD-3"))
            assert "ACCESS CODE:" in json.loads(ws.receive_text())["payload"]
            json.loads(ws.receive_text())  # prompt frame
            ws.send_text(ws_envelope(sid, "TIGERTEAM"))
            assert "CLEARANCE ACCEPTED" in json.loads(ws.receive_text())["payload"]

        # Resync: a new WS connection for the same session, same process —
        # the router's attachment (NORAD_OPS) survives this, unlike a restart.
        with c.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
            ws.send_text(ws_envelope(sid, "SITREP"))
            out = json.loads(ws.receive_text())
            assert "LOGON:" not in out["payload"]
            assert "SITREP NORAD-3" in out["payload"]


def test_ws_dialup_observe_gtw_is_refused(client):
    """A dialup-300 link can't carry the 2.5s telemetry feed (fidelity-notes.md);
    OBSERVE GTW must be refused, not gated later, and never reach the hub."""
    body = make_session(client)  # home-terminal -> dialup-300
    sid, token = body["session_id"], body["token"]
    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        json.loads(ws.receive_text())  # LOGON: greeting
        ws.send_text(ws_envelope(sid, "OBSERVE GTW"))
        out = json.loads(ws.receive_text())
        assert out["payload"].strip() == "FEED NOT AVAILABLE ON THIS LINE"


def test_ws_leased_9600_observe_gtw_is_not_refused(monkeypatch):
    """The counterpart to the dialup refusal: a leased-9600 link is allowed
    the feed and gets real GTW-FEED frames, not the refusal text."""
    import app.main as main_module

    real_hub_cls = main_module.GtwRoomHub
    monkeypatch.setattr(
        main_module, "GtwRoomHub",
        lambda *args: real_hub_cls(*args, interval_s=0.02, idle_grace_s=0.2),
    )
    store = MemoryStore()
    app = create_app(settings=Settings(), store=store, runner=_AlwaysPlayingRunner())
    client = TestClient(app)
    body = client.post("/api/session", json={"surface": "norad-terminal"}).json()
    sid, token = body["session_id"], body["token"]
    asyncio.run(store.upsert_game(GameState(sid, "gtw", "STATE", "PLAYING", 1)))

    with client.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        json.loads(ws.receive_text())  # LOGON: greeting
        ws.send_text(ws_envelope(sid, "OBSERVE GTW"))
        out = json.loads(ws.receive_text())
        assert out["payload"].strip() != "FEED NOT AVAILABLE ON THIS LINE"
        assert "GTW-FEED" in out["payload"]


def test_game_state_endpoint_404s_without_active_game(client):
    sid = make_session(client)["session_id"]
    assert client.get(f"/api/games/tictactoe/state/{sid}").status_code == 404
    assert client.get(f"/api/games/nope/state/{sid}").status_code == 404


def test_create_room_returns_short_code(client):
    r = client.post("/api/room")
    assert r.status_code == 201
    body = r.json()
    assert set(body) == {"room_code"}
    assert len(body["room_code"]) == 6
    assert body["room_code"] == body["room_code"].upper()


def test_get_room_metadata(client):
    code = client.post("/api/room").json()["room_code"]
    r = client.get(f"/api/room/{code}")
    assert r.status_code == 200
    assert r.json()["room_code"] == code
    assert client.get("/api/room/ZZZZZZ").status_code == 404


def test_session_can_join_existing_room(client):
    room = client.post("/api/room").json()["room_code"]
    r = client.post("/api/session", json={"surface": "norad-terminal", "room_code": room.lower()})
    assert r.status_code == 201
    body = r.json()
    assert body["room_code"] == room
    sid = body["session_id"]
    assert client.get(f"/api/session/{sid}").json()["room_code"] == room


def test_session_with_unknown_room_creates_it(client):
    r = client.post("/api/session", json={"surface": "home-terminal", "room_code": "AAAAAA"})
    assert r.status_code == 201
    assert r.json()["room_code"] == "AAAAAA"
    assert client.get("/api/room/AAAAAA").status_code == 200


def test_session_join_advances_room_last_seen(client):
    """Joining an existing room must touch its last_seen_at (#44) — one cheap
    write per join, so idle-room reaping has a truthful timestamp to work from."""
    room = client.post("/api/room").json()["room_code"]
    stale = "2020-01-01T00:00:00+00:00"
    client.app_store.rooms[room].last_seen_at = stale
    r = client.post("/api/session", json={"surface": "home-terminal", "room_code": room})
    assert r.status_code == 201
    assert client.app_store.rooms[room].last_seen_at != stale


def test_session_rejects_malformed_room_code(client):
    r = client.post("/api/session", json={"surface": "home-terminal", "room_code": "../bad"})
    assert r.status_code == 400


def test_generated_room_codes_span_full_alphabet(client):
    # Codes must draw from all of ROOM_ALPHABET, not just its hex subset:
    # 200 codes = 1200 chars, so letters beyond 'F' are a statistical certainty.
    async def gen():
        return [(await client.app_store.create_room()).code for _ in range(200)]

    chars = set("".join(asyncio.run(gen())))
    assert any(ch > "F" for ch in chars)


def test_create_room_with_explicit_code_is_idempotent(client):
    assert client.post("/api/room", json={"room_code": "BBBBBB"}).status_code == 201
    created = client.get("/api/room/BBBBBB").json()["created_at"]
    r = client.post("/api/room", json={"room_code": "BBBBBB"})
    assert r.status_code == 201
    assert r.json()["room_code"] == "BBBBBB"
    assert client.get("/api/room/BBBBBB").json()["created_at"] == created


def test_logon_banner_rides_above_the_prompt():
    """A trunk host's BRIDGE_LOGON_BANNER shows above LOGON: on a fresh line;
    unset (the default) leaves the prompt bare."""
    import dataclasses
    store = MemoryStore()
    settings = dataclasses.replace(Settings(), logon_banner="GREETINGS FROM SAO PAULO")
    c = TestClient(create_app(settings=settings, store=store))
    body = c.post("/api/session", json={"surface": "home-terminal"}).json()
    sid, token = body["session_id"], body["token"]
    with c.websocket_connect(f"/ws/session/{sid}?token={token}") as ws:
        greet = json.loads(ws.receive_text())["payload"]
    assert "GREETINGS FROM SAO PAULO" in greet
    assert "LOGON:" in greet
    # default: no banner, bare prompt
    c2 = TestClient(create_app(settings=Settings(), store=MemoryStore()))
    b2 = c2.post("/api/session", json={"surface": "home-terminal"}).json()
    with c2.websocket_connect(f"/ws/session/{b2['session_id']}?token={b2['token']}") as ws:
        greet2 = json.loads(ws.receive_text())["payload"]
    assert "GREETINGS FROM" not in greet2 and "LOGON:" in greet2
