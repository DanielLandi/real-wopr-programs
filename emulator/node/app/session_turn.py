"""One user turn, across a stack of programs.

localcall.run_resolving_calls finishes one program's turn, including any peer
CALLs it takes. This sits above it: a turn may also hand the terminal to
another program (EXEC) or hand it back (LINE RETURN), so what the caller sees
in one turn can span several programs.

The host owns the stack; no program can see below its own frame.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .execstack import Frame
from .localcall import run_resolving_calls
from .systemwire import MAX_EXEC_DEPTH

log = logging.getLogger("wopr.session_turn")


@dataclass(frozen=True)
class TurnResult:
    display: str
    prompt: str | None
    line: str               # UP | DROP — RETURN is resolved here, never returned
    frames: list[Frame]


async def run_session_turn(
    runner,
    frames: list[Frame],
    command: str,
    user_input: str | None,
    runtime_dir: Path,
    timeout_for: Callable[[str], float | None],
    execs_for: Callable[[str], tuple[str, ...]],
) -> TurnResult:
    frames = list(frames)
    displays: list[str] = []

    while True:
        top = frames[-1]
        resp = await run_resolving_calls(
            runner, top.program, command, top.state, user_input,
            runtime_dir=runtime_dir, timeout_s=timeout_for(top.program))
        if resp.display:
            displays.append(resp.display)
        frames[-1] = Frame(top.program, resp.state)

        if resp.exec_peer is not None:
            allowed = execs_for(top.program)
            if resp.exec_peer not in allowed:
                # Topology validation should have caught this at load; a
                # program reaching a peer it never declared is a bug, not a
                # caller error, so it is loud.
                raise ValueError(
                    f"{top.program} named an undeclared EXEC target "
                    f"{resp.exec_peer!r} (declared: {allowed})")
            # The bound is on stack DEPTH, across the session — not on pushes
            # within this turn (docs/systems.md §2.6: the two bounds are
            # independent). A per-turn counter would let a program that pushes
            # one frame per turn climb forever, one rung at a time.
            if len(frames) >= MAX_EXEC_DEPTH:
                log.warning("%s would exceed a return stack of %s, dropping line",
                            top.program, MAX_EXEC_DEPTH)
                return TurnResult("\n".join(displays), None, "DROP", frames)
            frames.append(Frame(resp.exec_peer, None))
            command, user_input = "CONNECT", None
            continue

        if resp.line == "RETURN":
            frames.pop()
            if not frames:
                # Nothing beneath it: the program finishing ends the call.
                # This is captive-account behaviour, with no rule of its own.
                return TurnResult("\n".join(displays), None, "DROP", frames)
            command, user_input = "RETURN", None
            continue

        return TurnResult("\n".join(displays), resp.prompt, resp.line, frames)
