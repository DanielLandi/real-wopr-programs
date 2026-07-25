"""Subprocess-per-request core runner (design.md §4, deployment.md D2).

Pool of N concurrent spawns (asyncio semaphore), bounded queue, hard wall-clock
timeout mapped to a defined error — never a stuck socket (api-contract.md §5).
"""

from __future__ import annotations

from . import sandbox
import asyncio
from dataclasses import dataclass
from pathlib import Path

from .wire import CoreResponse, WireError, build_request, parse_response


class CoreTimeout(Exception):
    """Core exceeded its wall-clock budget (-> 504 / error frame)."""


class CoreBusy(Exception):
    """Pool and queue are saturated (-> 503 / error frame)."""


class CoreError(Exception):
    """Core exited non-zero with a STATUS ERROR frame (docs/games.md §2.3)."""

    def __init__(self, response: CoreResponse | None, message: str):
        super().__init__(message)
        self.response = response


@dataclass
class RunnerConfig:
    bin_dir: Path
    timeout_s: float = 2.0
    pool_size: int = 4
    queue_size: int = 16
    queue_wait_s: float = 2.0


class CoreRunner:
    def __init__(self, cfg: RunnerConfig):
        self.cfg = cfg
        self._sem = asyncio.Semaphore(cfg.pool_size)
        self._waiting = 0

    def binary_for(self, game_id: str) -> Path:
        # game ids come from manifests, but never trust them as paths
        if not game_id.replace("-", "").replace("_", "").isalnum():
            raise CoreError(None, f"invalid game id {game_id!r}")
        # bin_dir is the pack's games/ dir; each game builds to <id>/harness/bin/<id>.
        return self.cfg.bin_dir / game_id / "harness" / "bin" / game_id

    async def run(
        self,
        game_id: str,
        command: str,
        state: str | None = None,
        move: str | None = None,
        timeout_s: float | None = None,
    ) -> CoreResponse:
        if self._waiting >= self.cfg.queue_size:
            raise CoreBusy("core queue full")
        self._waiting += 1
        try:
            try:
                await asyncio.wait_for(self._sem.acquire(), timeout=self.cfg.queue_wait_s)
            except TimeoutError as exc:
                raise CoreTimeout("queued too long for a core slot") from exc
        finally:
            self._waiting -= 1

        try:
            return await self._invoke(game_id, command, state, move, timeout_s or self.cfg.timeout_s)
        finally:
            self._sem.release()

    async def _invoke(
        self, game_id: str, command: str, state: str | None, move: str | None, timeout_s: float
    ) -> CoreResponse:
        binary = self.binary_for(game_id)
        if not binary.exists():
            raise CoreError(None, f"no binary for game {game_id!r} (run tools/import-programs.sh)")

        request = build_request(game_id, command, state, move)
        proc = await asyncio.create_subprocess_exec(
            str(binary),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            preexec_fn=sandbox.preexec(sandbox.GAME_MEM_MB),
        )
        try:
            stdout, _ = await asyncio.wait_for(
                proc.communicate(request.encode("ascii")), timeout=timeout_s
            )
        except RuntimeError as exc:
            proc.kill()
            await proc.wait()
            raise CoreError(None, f"subprocess pipe closed for game {game_id!r}: {exc}") from exc
        except TimeoutError as exc:
            proc.kill()
            await proc.wait()
            raise CoreTimeout(f"{game_id} exceeded {timeout_s}s") from exc
        except asyncio.CancelledError:
            # Don't orphan the child when the awaiting task is cancelled
            # (client hangup / server shutdown): reap it, then propagate —
            # parity with SystemRunner._invoke.
            proc.kill()
            await proc.wait()
            raise

        raw = stdout.decode("ascii", errors="replace")
        try:
            response = parse_response(raw, game_id)
        except WireError as exc:
            raise CoreError(None, f"unparseable core output: {exc}") from exc

        if proc.returncode != 0 or response.status == "ERROR":
            raise CoreError(response, response.result or "core error")
        return response
