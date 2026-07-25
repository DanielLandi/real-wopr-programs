import pytest
from app.systemwire import (
    build_system_request, parse_system_response, SystemResponse, SystemWireError,
)


def test_build_connect_has_no_state_or_input():
    req = build_system_request("reference", "CONNECT", None, None)
    assert req == "SYSTEM/1 reference CONNECT\nSTATE 0\nEND\n"


def test_build_input_carries_state_and_line():
    req = build_system_request("reference", "INPUT", "2", "HELLO")
    assert req == "SYSTEM/1 reference INPUT\nSTATE 1\n2\nINPUT HELLO\nEND\n"


def test_build_input_flattens_embedded_newlines():
    # A payload with CR/LF must not inject extra protocol lines: it stays one
    # INPUT line so the frame's line count is unambiguous.
    req = build_system_request("reference", "INPUT", "0", "A\nB\rC\r\nD")
    assert req == "SYSTEM/1 reference INPUT\nSTATE 1\n0\nINPUT A B C  D\nEND\n"
    # Exactly one line begins with "INPUT ".
    assert sum(1 for ln in req.splitlines() if ln.startswith("INPUT ")) == 1


def test_parse_roundtrip():
    raw = ("SYSTEM/1 reference OK\nSTATE 1\n3\nDISPLAY 1\n[3] YOU SAID: HI\n"
           "LINE UP\nEND\n")
    r = parse_system_response(raw, "reference")
    assert r == SystemResponse(system_id="reference", state="3",
                               display="[3] YOU SAID: HI", line="UP")


def test_parse_drop():
    raw = "SYSTEM/1 reference OK\nSTATE 0\nDISPLAY 1\nGOODBYE.\nLINE DROP\nEND\n"
    assert parse_system_response(raw, "reference").line == "DROP"


def test_parse_rejects_wrong_system():
    raw = "SYSTEM/1 other OK\nSTATE 0\nDISPLAY 0\nLINE UP\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")


def test_parse_rejects_bad_line_state():
    raw = "SYSTEM/1 reference OK\nSTATE 0\nDISPLAY 0\nLINE SIDEWAYS\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")


def test_parse_rejects_wrong_protocol_version():
    raw = "SYSTEM/2 reference OK\nSTATE 0\nDISPLAY 0\nLINE UP\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")


def test_parse_rejects_truncated_response_missing_end():
    raw = "SYSTEM/1 reference OK\nSTATE 0\nDISPLAY 1\nHELLO\nLINE UP\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")


def test_parse_rejects_bad_state_header_non_digit():
    raw = "SYSTEM/1 reference OK\nSTATE x\nDISPLAY 0\nLINE UP\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")


def test_parse_rejects_bad_display_header():
    raw = "SYSTEM/1 reference OK\nSTATE 0\nDISPLAY x\nLINE UP\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "reference")
