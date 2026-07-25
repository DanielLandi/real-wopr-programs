"""Regression: SYSTEM/1 subprocesses must be immune to the event-loop choice.

In production uvicorn auto-selects uvloop, whose libuv child transport gives
subprocesses socketpair-based stdio. The GnuCOBOL runtime mishandles that — it
misreads its stdin request and answers rc=1, so the bridge drops the line
(NO CARRIER) on every COBOL system dial (airline / reference). CI never caught
it because pytest runs the plain asyncio loop.

The SystemRunner now runs children via blocking subprocess.run on a worker
thread, so they get ordinary OS pipes regardless of the installed loop. This
test proves that by driving SystemRunner against the reference COBOL binary
*inside a fresh interpreter that has uvloop installed as the event loop* — the
exact prod condition. Without the runner fix it fails (line drops); with it,
the sentinel prints. Run it directly:

    .venv/bin/python -m pytest tests/test_systemrunner_uvloop.py -q
"""

import subprocess
import sys
from pathlib import Path

import pytest

APP_DIR = Path(__file__).resolve().parent.parent      # emulator/node/
REPO = APP_DIR.parent.parent                          # the pack root
SYS_DIR = REPO / "systems"
REF_BIN = SYS_DIR / "reference" / "harness" / "bin" / "reference"

uvloop = pytest.importorskip("uvloop", reason="uvloop not installed (pip install -e '.[dev]')")

needs_reference = pytest.mark.skipif(
    not REF_BIN.exists(),
    reason="reference not built (run tools/import-programs.sh)",
)

SENTINEL = "UVLOOP-SYSTEM-OK"

# Runs in a child interpreter with uvloop installed as the loop policy — i.e.
# the production event loop. Drives a real CONNECT through the reference COBOL
# binary and prints the sentinel only if the line comes up as expected.
CHILD = f"""
import asyncio, sys
import uvloop
uvloop.install()
sys.path.insert(0, {str(APP_DIR)!r})
from app.systemrunner import SystemRunner, SystemRunnerConfig
from pathlib import Path

async def main():
    runner = SystemRunner(SystemRunnerConfig(systems_dir=Path({str(SYS_DIR)!r})))
    resp = await runner.run("reference", "CONNECT", None, None)
    assert resp.line == "UP", resp
    assert "REFERENCE SYSTEM READY" in resp.display, resp
    print({SENTINEL!r})

asyncio.run(main())
"""


@needs_reference
def test_systemrunner_survives_uvloop():
    proc = subprocess.run(
        [sys.executable, "-c", CHILD],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, (
        f"child exited {proc.returncode}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
    assert SENTINEL in proc.stdout, (
        f"sentinel missing — reference dial failed under uvloop\n"
        f"stdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
    )
