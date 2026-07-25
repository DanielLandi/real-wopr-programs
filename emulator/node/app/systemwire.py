"""SYSTEM/1 wire codec — the dial-in-systems analog of WOPR/1 (docs/systems.md).

Sibling to wire.py: the bridge treats the STATE block as opaque; only the
system understands it. Verbs are CONNECT/INPUT and a LINE UP|DROP status.
"""

from __future__ import annotations

from dataclasses import dataclass

PROTO_SYSTEM = "SYSTEM/1"
LINE_STATES = {"UP", "DROP"}


class SystemWireError(Exception):
    """A system produced something that is not a valid SYSTEM/1 response."""


@dataclass(frozen=True)
class SystemResponse:
    system_id: str
    state: str      # opaque STATE block, newline-joined (no trailing newline)
    display: str    # human-facing teletype text
    line: str       # UP | DROP


def build_system_request(system_id: str, command: str, state: str | None,
                         user_input: str | None) -> str:
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

    line_hdr = take().split()
    if len(line_hdr) != 2 or line_hdr[0] != "LINE" or line_hdr[1] not in LINE_STATES:
        raise SystemWireError("bad LINE status")
    line = line_hdr[1]

    if take().strip() != "END":
        raise SystemWireError("missing END")

    return SystemResponse(system_id=system_id, state=state, display=display, line=line)
