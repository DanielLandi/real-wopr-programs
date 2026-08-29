"""Joshua placing a call.

The one place the bridge asks the relay for something. Everything else
between these two services runs the other way.

This function never raises. It is called from ws_session's `finally`, during
teardown, where the surrounding task may already be cancelled — so a failure
here must be a callback that does not happen, never a session that fails to
close.
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger("wopr.callback")


async def place_seat_call(trunk_url: str, internal_token: str, handle: str,
                          *, timeout_s: float = 5.0) -> str:
    """Ask the hub to ring `handle` on behalf of the flagship's own line.

    Returns "placed", or a refusal reason. Never raises.
    """
    if not trunk_url:
        # A monolith or a dev box with no hub. Not an error: there is simply
        # nobody to ask, and a machine with no trunk cannot call anyone.
        return "no hub"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            # `seat` alone. The hub reads `want.seat !== undefined ? {seat}
            # : {slot, world}` and derives the placing end from its own
            # homeSlot, which is the entire reason this route exists.
            resp = await client.post(
                f"{trunk_url.rstrip('/')}/trunk/place",
                json={"seat": handle},
                headers={"x-wopr-internal-token": internal_token},
            )
    except Exception as exc:                      # noqa: BLE001 — see docstring
        log.warning("callback: could not reach the hub: %r", exc)
        return "unreachable"

    if resp.status_code == 201:
        return "placed"
    try:
        refused = str(resp.json().get("refused", "")) or f"http {resp.status_code}"
    except Exception:                             # noqa: BLE001
        refused = f"http {resp.status_code}"
    log.info("callback: the hub refused the call: %s", refused)
    return refused
