"""Subprocess-per-request SYSTEM/1 runner — the dial-in-systems sibling of
runner.py's CoreRunner. Pool + queue + wall-clock timeout; errors map to a
clean line drop, never a hung socket."""

from __future__ import annotations

from . import sandbox
import asyncio
import subprocess
from dataclasses import dataclass
from pathlib import Path

from .systems import System
from .systemwire import (
    SystemResponse, SystemWireError, build_system_request, parse_system_response,
)


class SystemTimeout(Exception):
    """System exceeded its wall-clock budget."""


class SystemBusy(Exception):
    """Pool and queue are saturated."""


class SystemFault(Exception):
    """System exited non-zero or produced an unparseable response.

    Named SystemFault, not SystemError, to avoid shadowing Python's builtin
    OSError alias `SystemError` (CoreRunner used CoreError for the same reason)."""

    def __init__(self, response: SystemResponse | None, message: str):
        super().__init__(message)
        self.response = response


@dataclass
class SystemRunnerConfig:
    systems_dir: Path
    timeout_s: float = 2.0
    pool_size: int = 4
    queue_size: int = 16
    queue_wait_s: float = 2.0


class SystemRunner:
    def __init__(self, cfg: SystemRunnerConfig, systems: dict[str, System] | None = None):
        self.cfg = cfg
        self.systems = systems or {}
        self._sem = asyncio.Semaphore(cfg.pool_size)
        self._waiting = 0

    def binary_for(self, system_id: str) -> Path:
        if not system_id.replace("-", "").replace("_", "").isalnum():
            raise SystemFault(None, f"invalid system id {system_id!r}")
        sysinfo = self.systems.get(system_id)
        binname = sysinfo.binary if sysinfo else system_id
        # The pack builds each system to <id>/harness/bin/<binary>.
        return self.cfg.systems_dir / system_id / "harness" / "bin" / binname

    async def run(self, system_id: str, command: str, state: str | None,
                  user_input: str | None, timeout_s: float | None = None) -> SystemResponse:
        if self._waiting >= self.cfg.queue_size:
            raise SystemBusy("system queue full")
        self._waiting += 1
        try:
            try:
                await asyncio.wait_for(self._sem.acquire(), timeout=self.cfg.queue_wait_s)
            except TimeoutError as exc:
                raise SystemTimeout("queued too long for a system slot") from exc
        finally:
            self._waiting -= 1
        try:
            return await self._invoke(system_id, command, state, user_input,
                                      timeout_s or self.cfg.timeout_s)
        finally:
            self._sem.release()

    async def _invoke(self, system_id, command, state, user_input, timeout_s) -> SystemResponse:
        binary = self.binary_for(system_id)
        if not binary.exists():
            raise SystemFault(None, f"no binary for system {system_id!r} (run its build.sh)")
        request = build_system_request(system_id, command, state, user_input)
        # errors="replace" is symmetric with the stdout .decode below: a
        # non-ASCII user line becomes '?' rather than raising
        # UnicodeEncodeError up out of ws_session (the line stays up).
        stdin_bytes = request.encode("ascii", errors="replace")
        # Run the child via the plain (blocking) subprocess module on a worker
        # thread rather than asyncio.create_subprocess_exec. asyncio's child
        # transport is event-loop-specific: under uvloop (libuv) the child gets
        # socketpair-based stdio, which the GnuCOBOL runtime mishandles — it
        # misreads its stdin request and answers PROTOCOL ERROR / rc=1. Blocking
        # subprocess.run always gives the child ordinary OS pipes regardless of
        # which event loop is installed, so system binaries behave identically
        # under asyncio and uvloop.
        #
        # Cancellation caveat: a to_thread worker cannot be cancelled mid-run,
        # so a client hangup / server shutdown won't interrupt an in-flight
        # child — worst case the thread finishes and its result is dropped. The
        # wall-clock timeout below still bounds how long that thread can run.
        try:
            completed = await asyncio.to_thread(
                subprocess.run,
                [str(binary)],
                input=stdin_bytes,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=timeout_s,
                preexec_fn=sandbox.preexec(sandbox.SYSTEM_MEM_MB),
            )
        except subprocess.TimeoutExpired as exc:
            # subprocess.run already killed and reaped the child on timeout.
            raise SystemTimeout(f"{system_id} exceeded {timeout_s}s") from exc

        raw = completed.stdout.decode("ascii", errors="replace")
        try:
            response = parse_system_response(raw, system_id)
        except SystemWireError as exc:
            raise SystemFault(None, f"unparseable system output: {exc}") from exc
        if completed.returncode != 0:
            raise SystemFault(response, "system exited non-zero")
        return response
