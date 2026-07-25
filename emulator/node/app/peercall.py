"""Executing one `CALL` — a program asking for another machine, mid-turn.

The program does not open a connection; it says who it wants and what it wants,
and its host does the rest. That is the 1983 shape: an application issued a
request to the monitor and the monitor did the networking.

Every failure becomes a `Reply` the program can read, never an exception it
cannot. A subsystem being down was an ordinary Tuesday, and a program that has
to handle `FAIL` is a program that prints RECORDS UNAVAILABLE instead of hanging
a terminal.
"""

from __future__ import annotations

import asyncio
import json
import logging

import websockets

from .systemwire import MAX_CALL_DEPTH, Call, Reply
from .topology import NodeDecl, Topology

log = logging.getLogger("wopr.peercall")

DEFAULT_CALL_TIMEOUT_S = 5.0


def _fail(peer: str, why: str) -> Reply:
    log.info("call to %s failed: %s", peer, why)
    return Reply(peer=peer, status="FAIL", payload="")


async def _read_message(conn, timeout_s: float) -> str:
    """Collect envelope payloads until one is marked end-of-message.

    The relay's caller leg paces output through the same LinkShaper a surface
    gets, so an answer can arrive in several frames; `eom` is what says the
    application message is complete.
    """
    parts: list[str] = []
    while True:
        raw = await asyncio.wait_for(conn.recv(), timeout=timeout_s)
        env = json.loads(raw)
        payload = env.get("payload", "")
        if payload:
            parts.append(payload)
        if env.get("eom", True):
            return "\n".join(parts)


async def execute_call(
    call: Call,
    decl: NodeDecl,
    topology: Topology,
    relays: dict[str, str],
    caller: str,
    depth: int = 0,
    timeout_s: float = DEFAULT_CALL_TIMEOUT_S,
) -> Reply:
    """Dial `call.peer` on a network both nodes share and return its answer."""

    if depth >= MAX_CALL_DEPTH:
        return _fail(call.peer, f"call depth {depth} would exceed {MAX_CALL_DEPTH}")

    # A program cannot invent a peer. The reach is the manifest's to grant, and
    # the caller-side check is a courtesy — the callee's relay enforces it too,
    # because a caller is never trusted to police itself.
    if call.peer not in decl.peers:
        return _fail(call.peer, f"{decl.id} does not declare it as a peer")

    peer = topology.nodes.get(call.peer)
    if peer is None:
        return _fail(call.peer, "not a declared node")

    shared = [n for n in decl.networks if n in peer.networks]
    if not shared:
        return _fail(call.peer, f"{decl.id} shares no network with it")
    network = shared[0]

    url = relays.get(network)
    if url is None:
        return _fail(call.peer, f"no relay URL for network {network!r}")

    address = peer.networks[network].address
    dial = f"{url}/dial?address={_quote(address)}&from={_quote(caller)}"

    try:
        async with asyncio.timeout(timeout_s):
            async with websockets.connect(dial) as conn:
                # The peer greets on CONNECT; that is not our answer.
                await _read_message(conn, timeout_s)
                await conn.send(call.payload)
                answer = await _read_message(conn, timeout_s)
                return Reply(peer=call.peer, status="OK", payload=answer)
    except asyncio.TimeoutError:
        log.info("call to %s timed out after %ss", call.peer, timeout_s)
        return Reply(peer=call.peer, status="TIMEOUT", payload="")
    except websockets.ConnectionClosed as exc:
        # Includes the relay's NO ANSWER close: nobody holds that line, or we
        # are not permitted to reach whoever does. The caller cannot tell which,
        # by design.
        why = exc.rcvd.reason if exc.rcvd is not None else "no carrier"
        return _fail(call.peer, f"line closed: {why or 'no reason given'}")
    except (OSError, websockets.InvalidHandshake) as exc:
        return _fail(call.peer, f"could not reach the relay: {exc}")


def _quote(s: str) -> str:
    from urllib.parse import quote
    return quote(s, safe="")
