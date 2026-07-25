import pytest
from app.systemwire import (
    Call, Reply,
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


# ---- CALL / REPLY (the continuation) ----------------------------------------

def test_response_without_a_call_still_parses_with_call_none():
    raw = ("SYSTEM/1 school OK\nSTATE 1\nPHASE=MENU\nDISPLAY 1\nHELLO\n"
           "LINE UP\nEND\n")
    assert parse_system_response(raw, "school").call is None


def test_response_can_carry_a_call():
    raw = ("SYSTEM/1 school OK\nSTATE 1\nPHASE=AWAIT-GRADE\nDISPLAY 1\nSEARCHING...\n"
           "CALL school-db 1\nLOOKUP GRADE LIGHTMAN D\nLINE UP\nEND\n")
    r = parse_system_response(raw, "school")
    assert r.call == Call(peer="school-db", payload="LOOKUP GRADE LIGHTMAN D")
    assert r.display == "SEARCHING..."
    assert r.state == "PHASE=AWAIT-GRADE"


def test_a_multi_line_call_payload_round_trips():
    raw = ("SYSTEM/1 school OK\nSTATE 0\nDISPLAY 0\n"
           "CALL school-db 2\nLOOKUP GRADE LIGHTMAN D\nTERM SPRING-83\nLINE UP\nEND\n")
    assert parse_system_response(raw, "school").call.payload == (
        "LOOKUP GRADE LIGHTMAN D\nTERM SPRING-83")


def test_a_call_with_a_dropped_line_is_rejected():
    raw = ("SYSTEM/1 school OK\nSTATE 0\nDISPLAY 0\n"
           "CALL school-db 1\nLOOKUP X\nLINE DROP\nEND\n")
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "school")


def test_a_malformed_call_header_is_rejected():
    raw = ("SYSTEM/1 school OK\nSTATE 0\nDISPLAY 0\n"
           "CALL school-db\nLINE UP\nEND\n")
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "school")


def test_request_can_carry_a_reply():
    req = build_system_request("school", "RESUME", "PHASE=AWAIT-GRADE", None,
                               reply=Reply("school-db", "OK", "GRADE F\nTERM SPRING-83"))
    assert "REPLY school-db OK 2" in req
    assert req.endswith("END\n")
    assert "GRADE F" in req and "TERM SPRING-83" in req


def test_a_failed_reply_carries_no_payload_lines():
    req = build_system_request("school", "RESUME", "PHASE=AWAIT-GRADE", None,
                               reply=Reply("school-db", "FAIL", ""))
    assert "REPLY school-db FAIL 0" in req


def test_reply_status_must_be_known():
    with pytest.raises(SystemWireError):
        build_system_request("school", "RESUME", None, None,
                             reply=Reply("school-db", "MAYBE", ""))


def test_a_request_without_a_reply_is_byte_identical_to_before():
    """The extension is additive: nothing changes for a frame that has no REPLY."""
    assert build_system_request("reference", "CONNECT", None, None) == (
        "SYSTEM/1 reference CONNECT\nSTATE 0\nEND\n")
