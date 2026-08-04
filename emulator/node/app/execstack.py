"""The session's program stack.

A dial-in session used to be one program from CONNECT to LINE DROP. With
EXEC/RETURN (docs/systems.md §2.6) it is a stack: a monitor hands the terminal
to a records program, which hands it back. The host owns the stack — programs
never see it — and stores it in the same opaque system-state slot a single
program's STATE used to occupy.

JSON, because the host owns this blob and nothing period reads it. A program's
own STATE is still the opaque line-block it always was; it just rides inside.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

FORMAT_VERSION = 1


@dataclass(frozen=True)
class Frame:
    program: str
    state: str | None


def encode(frames: list[Frame]) -> str:
    return json.dumps({
        "v": FORMAT_VERSION,
        "stack": [{"p": f.program, "s": f.state} for f in frames],
    })


def decode(raw: str | None, root_program: str) -> list[Frame]:
    """The stack this session left off with, or a fresh one.

    Anything unreadable — a session stored before this format, a truncated row
    — starts clean rather than raising: the caller is on a phone line, and a
    fresh CONNECT is a better answer than a dropped one.
    """
    if not raw:
        return [Frame(root_program, None)]
    try:
        blob = json.loads(raw)
        if blob.get("v") != FORMAT_VERSION:
            return [Frame(root_program, None)]
        frames = [Frame(program=e["p"], state=e["s"]) for e in blob["stack"]]
    except (ValueError, TypeError, KeyError):
        return [Frame(root_program, None)]
    return frames or [Frame(root_program, None)]
