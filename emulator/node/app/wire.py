"""WOPR/1 wire codec — build requests / parse responses (docs/games.md §2).

The bridge treats the STATE block as opaque text (data-model.md); only the
game itself understands it.
"""

from __future__ import annotations

from dataclasses import dataclass

PROTO = "WOPR/1"

STATUSES = {"PLAYING", "WIN", "LOSS", "DRAW", "NO-WIN", "ERROR"}


class WireError(Exception):
    """The core produced something that is not a valid WOPR/1 response."""


@dataclass(frozen=True)
class CoreResponse:
    game_id: str
    state: str          # opaque STATE block, newline-joined (no trailing newline)
    display: str        # human-facing teletype text
    status: str
    result: str | None


def build_request(game_id: str, command: str, state: str | None, move: str | None) -> str:
    """Serialize a request frame. `state` is the stored opaque block (None for NEW);
    `move` omitted => the engine plays the current side (T1 convention).

    Relies on the router pre-validating/normalizing `move` (no embedded CR/LF)
    before it reaches here — unlike systemwire, which flattens newlines itself
    because arbitrary terminal input reaches it unmediated."""
    lines = [f"{PROTO} {game_id} {command}"]
    state_lines = state.split("\n") if state else []
    lines.append(f"STATE {len(state_lines)}")
    lines.extend(state_lines)
    if move is not None:
        lines.append(f"INPUT {move}")
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

    status_line = take()
    if not status_line.startswith("STATUS "):
        raise WireError("missing STATUS")
    status = status_line[len("STATUS "):].strip()
    if status not in STATUSES:
        raise WireError(f"unknown STATUS {status!r}")

    result: str | None = None
    line = take()
    if line.startswith("RESULT "):
        result = line[len("RESULT "):]
        line = take()
    if line.strip() != "END":
        raise WireError("missing END")

    return CoreResponse(game_id=game_id, state=state, display=display, status=status, result=result)
