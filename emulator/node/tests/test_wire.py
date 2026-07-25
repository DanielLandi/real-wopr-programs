"""WOPR/1 codec tests (docs/games.md §2)."""

import pytest

from app.wire import Call, Reply, WireError, build_request, parse_response


def test_build_new_request_has_empty_state_and_no_input():
    assert build_request("tictactoe", "NEW", None, None) == (
        "WOPR/1 tictactoe NEW\nSTATE 0\nEND\n"
    )


def test_build_move_request_round_trips_state_and_move():
    req = build_request("tictactoe", "MOVE", "X...O....\nTURN X", "4")
    assert req == (
        "WOPR/1 tictactoe MOVE\nSTATE 2\nX...O....\nTURN X\nINPUT 4\nEND\n"
    )


def test_build_engine_move_omits_input():
    req = build_request("tictactoe", "MOVE", "X...O....\nTURN O", None)
    assert "INPUT" not in req


def test_parse_response_full_frame():
    raw = (
        "WOPR/1 tictactoe OK\nSTATE 2\nX..XO....\nTURN O\nDISPLAY 5\n"
        " X | . | .\n-----------\n X | O | .\n-----------\n . | . | .\n"
        "STATUS PLAYING\nEND\n"
    )
    r = parse_response(raw, "tictactoe")
    assert r.state == "X..XO....\nTURN O"
    assert r.display.count("\n") == 4
    assert r.status == "PLAYING"
    assert r.result is None


def test_parse_response_with_result_line():
    raw = (
        "WOPR/1 tictactoe OK\nSTATE 2\nXOXXOOOXX\nTURN O\nDISPLAY 1\nBOARD\n"
        "STATUS NO-WIN\nRESULT A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.\nEND\n"
    )
    r = parse_response(raw, "tictactoe")
    assert r.status == "NO-WIN"
    assert r.result.startswith("A STRANGE GAME")


@pytest.mark.parametrize("raw", [
    "",
    "WOPR/2 tictactoe OK\nSTATE 0\nDISPLAY 0\nSTATUS PLAYING\nEND\n",
    "WOPR/1 gtw OK\nSTATE 0\nDISPLAY 0\nSTATUS PLAYING\nEND\n",   # wrong game
    "WOPR/1 tictactoe OK\nSTATE 1\nEND\n",                        # truncated state
    "WOPR/1 tictactoe OK\nSTATE 0\nDISPLAY 0\nSTATUS WEIRD\nEND\n",
])
def test_parse_response_rejects_malformed(raw):
    with pytest.raises(WireError):
        parse_response(raw, "tictactoe")


# ---- CALL / REPLY (the continuation) ----------------------------------------

def test_response_without_a_call_still_parses_with_call_none():
    raw = "WOPR/1 gtw OK\nSTATE 1\nT=1\nDISPLAY 1\nREADY\nSTATUS PLAYING\nEND\n"
    assert parse_response(raw, "gtw").call is None


def test_response_can_carry_a_call():
    raw = ("WOPR/1 gtw OK\nSTATE 1\nT=1\nDISPLAY 1\nSCANNING\n"
           "CALL radar-central 1\nTRACKS SECTOR 7\nSTATUS PLAYING\nEND\n")
    r = parse_response(raw, "gtw")
    assert r.call == Call(peer="radar-central", payload="TRACKS SECTOR 7")
    assert r.status == "PLAYING"
    assert r.display == "SCANNING"


def test_a_call_still_allows_a_trailing_result_line():
    raw = ("WOPR/1 gtw OK\nSTATE 0\nDISPLAY 0\n"
           "CALL radar-central 1\nTRACKS\nSTATUS PLAYING\nRESULT PENDING\nEND\n")
    r = parse_response(raw, "gtw")
    assert r.call.peer == "radar-central"
    assert r.result == "PENDING"


def test_a_call_alongside_a_terminal_status_is_rejected():
    raw = ("WOPR/1 gtw OK\nSTATE 0\nDISPLAY 0\n"
           "CALL radar-central 1\nTRACKS\nSTATUS NO-WIN\nEND\n")
    with pytest.raises(WireError):
        parse_response(raw, "gtw")


def test_a_malformed_call_header_is_rejected():
    raw = "WOPR/1 gtw OK\nSTATE 0\nDISPLAY 0\nCALL radar-central\nSTATUS PLAYING\nEND\n"
    with pytest.raises(WireError):
        parse_response(raw, "gtw")


def test_request_can_carry_a_reply():
    req = build_request("gtw", "RESUME", "T=1", None,
                        reply=Reply("radar-central", "OK", "TRK 001 BEAR-01"))
    assert "REPLY radar-central OK 1" in req
    assert req.endswith("END\n")


def test_a_failed_reply_carries_no_payload_lines():
    req = build_request("gtw", "RESUME", "T=1", None,
                        reply=Reply("radar-central", "FAIL", ""))
    assert "REPLY radar-central FAIL 0" in req


def test_reply_status_must_be_known():
    with pytest.raises(WireError):
        build_request("gtw", "RESUME", None, None, reply=Reply("radar-central", "NOPE", ""))


def test_a_request_without_a_reply_is_byte_identical_to_before():
    assert build_request("gtw", "NEW", None, None) == "WOPR/1 gtw NEW\nSTATE 0\nEND\n"
