"""Resolving a program's CALL without a network.

The federation gives a node a relay and dials its peers across it. The monolith
does not need one: it mounts every program, so a peer call is simply another
local invocation. Same contract, same CALL/REPLY frames, same store semantics —
only the distance differs.

That is what keeps a program honest. `school` asks for a grade the same way
whether it is running as a node with `school-db` on the far end of a bus, or
inside a single process that happens to hold both.
"""

from __future__ import annotations

import logging
from pathlib import Path

from .storestate import StoreState
from .systemrunner import SystemBusy, SystemFault, SystemRunner, SystemTimeout
from .systemwire import MAX_CALL_DEPTH, Call, Reply, SystemResponse

log = logging.getLogger("wopr.localcall")


async def _answer_locally(runner: SystemRunner, call: Call, runtime_dir: Path) -> Reply:
    """Run the peer program here, and give back whatever it displayed."""
    store = StoreState(runtime_dir, call.peer)
    try:
        resp = await runner.run(call.peer, "INPUT", store.load(), call.payload)
    except (SystemFault, SystemTimeout, SystemBusy) as exc:
        log.info("local call to %s failed: %r", call.peer, exc)
        status = "TIMEOUT" if isinstance(exc, SystemTimeout) else "FAIL"
        return Reply(peer=call.peer, status=status, payload="")
    # A peer that keeps state keeps it here too, so a grade set on one call is
    # there on the next — the same promise the node host makes.
    store.save(resp.state)
    return Reply(peer=call.peer, status="OK", payload=resp.display)


async def run_resolving_calls(
    runner: SystemRunner,
    system_id: str,
    command: str,
    state: str | None,
    user_input: str | None,
    runtime_dir: Path,
    timeout_s: float | None = None,
) -> SystemResponse:
    """One user turn, including any peer calls it takes to finish.

    Every DISPLAY along the way is kept and joined, so the caller still sees
    SEARCHING... before the answer rather than only the final screen.
    """
    displays: list[str] = []
    reply: Reply | None = None
    depth = 0

    while True:
        resp = await runner.run(system_id, command, state, user_input,
                                timeout_s=timeout_s, reply=reply)
        if resp.display:
            displays.append(resp.display)

        if resp.call is None:
            break
        if depth >= MAX_CALL_DEPTH:
            log.warning("%s exceeded %s chained calls", system_id, MAX_CALL_DEPTH)
            reply = Reply(peer=resp.call.peer, status="FAIL", payload="")
        else:
            reply = await _answer_locally(runner, resp.call, runtime_dir)
        depth += 1
        command, user_input, state = "RESUME", None, resp.state

    return SystemResponse(
        system_id=resp.system_id,
        state=resp.state,
        display="\n".join(displays),
        line=resp.line,
        call=None,
        prompt=resp.prompt,
        # EXEC (docs/systems.md §2.6) can't accompany CALL, so a response that
        # reaches here with exec_peer set never took the reply loop above —
        # but it still has to survive the trip out, or the layer above this
        # one (session_turn) can never see a program handing off the line.
        exec_peer=resp.exec_peer,
    )
