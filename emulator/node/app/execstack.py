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
        if not isinstance(blob, dict):
            return [Frame(root_program, None)]
        if blob.get("v") != FORMAT_VERSION:
            return [Frame(root_program, None)]
        stack = blob["stack"]
        if not isinstance(stack, list):
            return [Frame(root_program, None)]
        frames = []
        for e in stack:
            # Shape is not enough: `{"p": 1}` has the right key and used to
            # decode to Frame(program=1), and `program` is then looked up as
            # a system id and handed to the runner. Check the types here,
            # where the answer is still "start clean" (#47).
            if not isinstance(e, dict):
                return [Frame(root_program, None)]
            program, state = e["p"], e["s"]
            if not isinstance(program, str):
                return [Frame(root_program, None)]
            if state is not None and not isinstance(state, str):
                return [Frame(root_program, None)]
            frames.append(Frame(program=program, state=state))
    except (ValueError, TypeError, KeyError):
        return [Frame(root_program, None)]
    return frames or [Frame(root_program, None)]
