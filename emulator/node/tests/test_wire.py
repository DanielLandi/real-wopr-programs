"""WOPR/1 codec tests (docs/games.md §2)."""

import pytest

from app.wire import WireError, build_request, parse_response


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
