"""SYSTEM/1 wire codec — the dial-in-systems analog of WOPR/1 (docs/systems.md).

Sibling to wire.py: the bridge treats the STATE block as opaque; only the
system understands it. Verbs are CONNECT/INPUT and a LINE UP|DROP status.
"""

from __future__ import annotations

from dataclasses import dataclass

PROTO_SYSTEM = "SYSTEM/1"
LINE_STATES = {"UP", "DROP", "RETURN"}
REPLY_STATUSES = {"OK", "FAIL", "TIMEOUT"}

# How many peer calls one user turn may chain before the host gives up. Bounds a
# program that keeps asking; cycles are caught earlier, at topology validation.
MAX_CALL_DEPTH = 4

# How deep the host will stack programs that hand each other the terminal.
# Not the same kind of bound as MAX_CALL_DEPTH above: a chained CALL is bounded
# within one program's turn, but this stack accumulates across the whole
# session — a caller sits on it from its EXEC until the peer (or something the
# peer itself EXECs) returns. Left unbounded, a chain of monitors handing off
# to one another could grow the return stack for as long as the call lasts.
MAX_EXEC_DEPTH = 4


class SystemWireError(Exception):
    """A system produced something that is not a valid SYSTEM/1 response."""


@dataclass(frozen=True)
class Call:
    """A program asking its host to reach a peer, mid-turn.

    The payload is opaque to the harness — only the two programs understand it,
    exactly as STATE is opaque. This is the CICS pseudo-conversational shape:
    the program ends, and the monitor restarts it with the answer.
    """
    peer: str
    payload: str        # newline-joined, no trailing newline


@dataclass(frozen=True)
class Reply:
    peer: str
    status: str         # OK | FAIL | TIMEOUT
    payload: str        # newline-joined; empty for FAIL/TIMEOUT


@dataclass(frozen=True)
class SystemResponse:
    system_id: str
    state: str      # opaque STATE block, newline-joined (no trailing newline)
    display: str    # human-facing teletype text
    line: str       # UP | DROP | RETURN
    call: Call | None = None
    prompt: str | None = None   # what the system is asking, for the input line
    exec_peer: str | None = None   # EXEC <peer>: hand the terminal over


def build_system_request(system_id: str, command: str, state: str | None,
                         user_input: str | None, reply: Reply | None = None) -> str:
    lines = [f"{PROTO_SYSTEM} {system_id} {command}"]
    state_lines = state.split("\n") if state else []
    lines.append(f"STATE {len(state_lines)}")
    lines.extend(state_lines)
    if user_input is not None:
        # One INPUT line, always: a raw user payload can carry CR/LF (arbitrary
        # terminal input reaches here directly, unlike wire.py's pre-validated
        # moves), which would otherwise inject extra protocol lines and desync
        # the frame. Flatten embedded newlines to spaces.
        user_input = user_input.replace("\r", " ").replace("\n", " ")
        lines.append(f"INPUT {user_input}")
    if reply is not None:
        # The answer to the CALL the program made last turn. Counted like STATE
        # so the program reads exactly as many lines as were sent.
        if reply.status not in REPLY_STATUSES:
            raise SystemWireError(f"unknown REPLY status {reply.status!r}")
        payload_lines = reply.payload.split("\n") if reply.payload else []
        lines.append(f"REPLY {reply.peer} {reply.status} {len(payload_lines)}")
        lines.extend(payload_lines)
    lines.append("END")
    return "\n".join(lines) + "\n"


def parse_system_response(raw: str, system_id: str) -> SystemResponse:
    lines = raw.splitlines()
    i = 0

    def take() -> str:
        nonlocal i
        if i >= len(lines):
            raise SystemWireError("unexpected end of response")
        line = lines[i]
        i += 1
        return line

    header = take().split()
    if len(header) != 3 or header[0] != PROTO_SYSTEM or header[2] != "OK":
        raise SystemWireError(f"bad header: {lines[0] if lines else '<empty>'}")
    if header[1] != system_id:
        raise SystemWireError(f"response for wrong system: {header[1]}")

    state_hdr = take().split()
    if len(state_hdr) != 2 or state_hdr[0] != "STATE" or not state_hdr[1].isdigit():
        raise SystemWireError("bad STATE header")
    state = "\n".join(take() for _ in range(int(state_hdr[1])))

    disp_hdr = take().split()
    if len(disp_hdr) != 2 or disp_hdr[0] != "DISPLAY" or not disp_hdr[1].isdigit():
        raise SystemWireError("bad DISPLAY header")
    display = "\n".join(take() for _ in range(int(disp_hdr[1])))

    # Optional CALL block: the program is asking for a peer before it can
    # finish this turn. Absent in every frame that does not use the extension,
    # so an old-style response parses exactly as it always did.
    call: Call | None = None
    peeked = take()
    if peeked.startswith("CALL "):
        parts = peeked.split()
        if len(parts) != 3 or not parts[2].isdigit():
            raise SystemWireError("bad CALL header")
        call = Call(peer=parts[1], payload="\n".join(take() for _ in range(int(parts[2]))))
        peeked = take()

    # Optional EXEC block: the program is handing the terminal to a peer. Sits
    # in the same slot as CALL and is mutually exclusive with it — one turn
    # hands over once.
    exec_peer: str | None = None
    if peeked.startswith("EXEC "):
        if call is not None:
            raise SystemWireError("EXEC may not accompany CALL")
        parts = peeked.split()
        if len(parts) != 2 or not parts[1]:
            raise SystemWireError("bad EXEC header")
        exec_peer = parts[1]
        peeked = take()

    # Optional PROMPT: what the system is asking, delivered on the input line
    # rather than in the transcript. A continuation (CALL) is not ready for
    # input, and a dropped line asks nothing — both are rejected. A program
    # that hands over the terminal (EXEC) supplies no prompt of its own; the
    # peer it hands to will.
    prompt: str | None = None
    if peeked.startswith("PROMPT "):
        if call is not None:
            raise SystemWireError("PROMPT may not accompany CALL")
        if exec_peer is not None:
            raise SystemWireError("PROMPT may not accompany EXEC")
        prompt = peeked[len("PROMPT "):]
        if not prompt.strip():
            raise SystemWireError("empty PROMPT")
        peeked = take()

    line_hdr = peeked.split()
    if len(line_hdr) != 2 or line_hdr[0] != "LINE" or line_hdr[1] not in LINE_STATES:
        raise SystemWireError("bad LINE status")
    line = line_hdr[1]

    if call is not None and line != "UP":
        # A CALL is a continuation: the program is going to be resumed, so the
        # line cannot be going away underneath it.
        raise SystemWireError("CALL requires LINE UP")

    if exec_peer is not None and line != "UP":
        # The caller is going to be resumed when the exec'd program returns,
        # so the line cannot be going away underneath it.
        raise SystemWireError("EXEC requires LINE UP")

    if prompt is not None and line != "UP":
        raise SystemWireError("PROMPT requires LINE UP")

    if take().strip() != "END":
        raise SystemWireError("missing END")

    return SystemResponse(system_id=system_id, state=state, display=display,
                          line=line, call=call, prompt=prompt, exec_peer=exec_peer)
