"""Subprocess runner tests (deployment.md D2, api-contract.md §5).

Uses the REAL tictactoe binary when built (golden truth), plus synthetic
binaries for the timeout and garbage-output paths.
"""

import asyncio
import os
import stat
from pathlib import Path

import pytest

from app.runner import CoreError, CoreRunner, CoreTimeout, RunnerConfig

REPO = Path(__file__).resolve().parent.parent.parent.parent
REAL_BIN = REPO / "games"

needs_core = pytest.mark.skipif(
    not (REAL_BIN / "tictactoe" / "core" / "harness" / "bin" / "tictactoe").exists(),
    reason="core not built (run tools/import-programs.sh)",
)


def make_fake_binary(dir: Path, name: str, script: str) -> None:
    # binary_for resolves <bin_dir>/<id>/harness/bin/<id> (the pack layout).
    p = dir / name / "harness" / "bin" / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"#!/bin/sh\n{script}\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)


@needs_core
def test_real_core_new_and_move():
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))

    async def flow():
        # The film's opening question comes first: players, then side, then
        # cells. The game is self-resolving, so the engine's reply arrives
        # inside the human's own MOVE — there is no inputless follow-up.
        new = await runner.run("tictactoe", "NEW", interp_dir="core")
        assert new.status == "PLAYING"
        assert new.state == "MODE ASK\n.........\nTURN X"
        assert "ONE OR TWO PLAYERS?" in new.display
        one = await runner.run("tictactoe", "MOVE", new.state, "1", interp_dir="core")
        assert one.state == "MODE PICK\n.........\nTURN X"
        assert one.display == "X OR O?"
        picked = await runner.run("tictactoe", "MOVE", one.state, "X", interp_dir="core")
        assert picked.state == "MODE ONE-X\n.........\nTURN X"
        moved = await runner.run("tictactoe", "MOVE", picked.state, "5", interp_dir="core")
        # deterministic corner reply, played in the same response
        assert moved.state == "MODE ONE-X\nO...X....\nTURN X"

    asyncio.run(flow())


@needs_core
def test_real_core_error_frame_maps_to_core_error():
    runner = CoreRunner(RunnerConfig(bin_dir=REAL_BIN))

    async def flow():
        new = await runner.run("tictactoe", "NEW", interp_dir="core")
        with pytest.raises(CoreError) as exc:
            await runner.run("tictactoe", "MOVE", new.state, "Q", interp_dir="core")
        assert "INVALID MOVE" in str(exc.value)

    asyncio.run(flow())


def test_hung_core_hits_timeout_not_a_stuck_socket(tmp_path):
    make_fake_binary(tmp_path, "sleeper", "sleep 30")
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path, timeout_s=0.3))

    async def flow():
        with pytest.raises(CoreTimeout):
            await runner.run("sleeper", "MOVE", "", "1")

    asyncio.run(flow())


def test_garbage_output_maps_to_core_error(tmp_path):
    make_fake_binary(tmp_path, "garbage", "echo NOT A WOPR FRAME")
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path, timeout_s=1))

    async def flow():
        with pytest.raises(CoreError):
            await runner.run("garbage", "MOVE", "", "1")

    asyncio.run(flow())


def test_closed_subprocess_pipe_maps_to_core_error_and_reaps(tmp_path, monkeypatch):
    make_fake_binary(tmp_path, "closed", "exit 127")
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path, timeout_s=1))
    reaped = []

    class ClosedPipeProc:
        returncode = 127

        async def communicate(self, _input):
            raise RuntimeError("unable to perform operation on closed transport")

        def kill(self):
            reaped.append("kill")

        async def wait(self):
            reaped.append("wait")
            return 127

    async def fake_exec(*_args, **_kwargs):
        return ClosedPipeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def flow():
        with pytest.raises(CoreError) as exc:
            await runner.run("closed", "NEW")
        assert "subprocess pipe closed" in str(exc.value)
        # SystemRunner parity (#51): the child is killed and waited, not leaked.
        assert reaped == ["kill", "wait"]

    asyncio.run(flow())


def test_cancelled_call_reaps_subprocess(tmp_path, monkeypatch):
    """Cancelling a core call (client hangup / shutdown) must not orphan the
    child: CoreRunner needs SystemRunner's CancelledError reap (#51)."""
    make_fake_binary(tmp_path, "hang", "sleep 30")
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path, timeout_s=30))
    reaped = []

    class HangingProc:
        returncode = None

        def __init__(self):
            self._blocked = asyncio.Event()

        async def communicate(self, _input):
            await self._blocked.wait()  # never set: hangs until cancelled

        def kill(self):
            reaped.append("kill")

        async def wait(self):
            reaped.append("wait")
            return -9

    async def fake_exec(*_args, **_kwargs):
        return HangingProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)

    async def flow():
        task = asyncio.create_task(runner.run("hang", "NEW"))
        await asyncio.sleep(0.05)  # let it reach proc.communicate
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert reaped == ["kill", "wait"]

    asyncio.run(flow())


def test_missing_binary_is_a_defined_error(tmp_path):
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path))

    async def flow():
        with pytest.raises(CoreError) as exc:
            await runner.run("nonexistent", "NEW")
        assert "no binary" in str(exc.value)

    asyncio.run(flow())


def test_path_traversal_game_ids_rejected(tmp_path):
    runner = CoreRunner(RunnerConfig(bin_dir=tmp_path))

    async def flow():
        with pytest.raises(CoreError):
            await runner.run("../evil", "NEW")

    asyncio.run(flow())
