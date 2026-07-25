"""WOPR/1 wire codec — build requests / parse responses (docs/games.md §2).

The bridge treats the STATE block as opaque text (data-model.md); only the
game itself understands it.
"""

from __future__ import annotations

from dataclasses import dataclass

PROTO = "WOPR/1"

STATUSES = {"PLAYING", "WIN", "LOSS", "DRAW", "NO-WIN", "ERROR"}
# A finished game has nothing to resume into, so it may not ask for a peer.
TERMINAL_STATUSES = {"WIN", "LOSS", "DRAW", "NO-WIN", "ERROR"}
REPLY_STATUSES = {"OK", "FAIL", "TIMEOUT"}

# How many peer calls one user turn may chain before the host gives up. Bounds a
# program that keeps asking; cycles are caught earlier, at topology validation.
MAX_CALL_DEPTH = 4


class WireError(Exception):
    """The core produced something that is not a valid WOPR/1 response."""


@dataclass(frozen=True)
class Call:
    """A game asking its host to reach a peer, mid-turn. Payload is opaque.

    Deliberately declared here rather than imported from systemwire: WOPR/1 and
    SYSTEM/1 are separate protocols, and modules do not share code across the
    federation boundary (AGENTS.md). Spec-level duplication is the allowed cost.
    """
    peer: str
    payload: str


@dataclass(frozen=True)
class Reply:
    peer: str
    status: str         # OK | FAIL | TIMEOUT
    payload: str


@dataclass(frozen=True)
class CoreResponse:
    game_id: str
    state: str          # opaque STATE block, newline-joined (no trailing newline)
    display: str        # human-facing teletype text
    status: str
    result: str | None
    call: Call | None = None


def build_request(game_id: str, command: str, state: str | None, move: str | None,
                  reply: Reply | None = None) -> str:
    """Serialize a request frame. `state` is the stored opaque block (None for NEW);
    `move` omitted => the engine plays the current side (T1 convention).

    Flattens embedded CR/LF in `move`, exactly as systemwire does: since routing
    became attachment-based, arbitrary terminal input reaches here unmediated and
    a stray newline would inject extra protocol lines and desync the frame.
    """
    lines = [f"{PROTO} {game_id} {command}"]
    state_lines = state.split("\n") if state else []
    lines.append(f"STATE {len(state_lines)}")
    lines.extend(state_lines)
    if move is not None:
        lines.append(f"INPUT {move.replace(chr(13), ' ').replace(chr(10), ' ')}")
    if reply is not None:
        # The answer to the CALL the game made last turn. Counted like STATE so
        # the program reads exactly as many lines as were sent.
        if reply.status not in REPLY_STATUSES:
            raise WireError(f"unknown REPLY status {reply.status!r}")
        payload_lines = reply.payload.split("\n") if reply.payload else []
        lines.append(f"REPLY {reply.peer} {reply.status} {len(payload_lines)}")
        lines.extend(payload_lines)
    lines.append("END")
    return "\n".join(lines) + "\n"


def parse_response(raw: str, game_id: str) -> CoreResponse:
    lines = raw.splitlines()
    i = 0

    def take() -> str:
        nonlocal i
        if i >= len(lines):
            raise WireError("unexpected end of response")
        line = lines[i]
        i += 1
        return line

    header = take().split()
    if len(header) != 3 or header[0] != PROTO or header[2] != "OK":
        raise WireError(f"bad header: {lines[0] if lines else '<empty>'}")
    if header[1] != game_id:
        raise WireError(f"response for wrong game: {header[1]}")

    state_hdr = take().split()
    if len(state_hdr) != 2 or state_hdr[0] != "STATE" or not state_hdr[1].isdigit():
        raise WireError("bad STATE header")
    n = int(state_hdr[1])
    state = "\n".join(take() for _ in range(n))

    disp_hdr = take().split()
    if len(disp_hdr) != 2 or disp_hdr[0] != "DISPLAY" or not disp_hdr[1].isdigit():
        raise WireError("bad DISPLAY header")
    k = int(disp_hdr[1])
    display = "\n".join(take() for _ in range(k))

    # Optional CALL block: the game is asking for a peer before it can finish
    # this turn. Absent in every frame that does not use the extension, so an
    # old-style response parses exactly as it always did.
    call: Call | None = None
    status_line = take()
    if status_line.startswith("CALL "):
        parts = status_line.split()
        if len(parts) != 3 or not parts[2].isdigit():
            raise WireError("bad CALL header")
        call = Call(peer=parts[1], payload="\n".join(take() for _ in range(int(parts[2]))))
        status_line = take()

    if not status_line.startswith("STATUS "):
        raise WireError("missing STATUS")
    status = status_line[len("STATUS "):].strip()
    if status not in STATUSES:
        raise WireError(f"unknown STATUS {status!r}")
    if call is not None and status in TERMINAL_STATUSES:
        raise WireError(f"CALL with terminal STATUS {status}")

    result: str | None = None
    line = take()
    if line.startswith("RESULT "):
        result = line[len("RESULT "):]
        line = take()
    if line.strip() != "END":
        raise WireError("missing END")

    return CoreResponse(game_id=game_id, state=state, display=display, status=status,
                        result=result, call=call)
