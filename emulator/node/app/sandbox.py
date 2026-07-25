"""Resource limits for the period-language program subprocesses.

Every game/system/Joshua binary runs as a subprocess (runner.py, systemrunner.py,
joshua.py). A hostile or buggy program must not be able to exhaust the host — so
each child is capped, before exec, on address space (memory), CPU seconds, and
core dumps. This is a lightweight per-process fence via POSIX rlimits; it pairs
with the wall-clock timeouts each runner already applies, and with a container
memory limit at the deploy layer. It does not isolate the filesystem or network
(a locked-down container is the tool for that) — its job is to stop the "allocate
GBs and take down the box" class of failure cheaply.

Games and systems are the contributor-facing attack surface, so they get a tight
cap. Joshua is owner-authored Common Lisp; SBCL reserves a large virtual space at
startup, so it gets more headroom. All caps are env-tunable.
"""

from __future__ import annotations

import os
import resource
import sys
from typing import Callable

# Contributor-facing programs run tight; Joshua (SBCL) needs room to reserve.
GAME_MEM_MB = int(os.environ.get("BRIDGE_GAME_MEM_MB", "512"))
SYSTEM_MEM_MB = int(os.environ.get("BRIDGE_SYSTEM_MEM_MB", "512"))
JOSHUA_MEM_MB = int(os.environ.get("BRIDGE_JOSHUA_MEM_MB", "2048"))
# CPU-seconds backstop above every wall-clock timeout — kills a pathological
# spinner even if it stays within its wall-clock budget.
CPU_SECONDS = int(os.environ.get("BRIDGE_PROGRAM_CPU_S", "30"))


def preexec(mem_mb: int) -> Callable[[], None]:
    """Return a preexec_fn (runs in the forked child, before exec) that applies
    the rlimits. It makes only setrlimit syscalls — no Python locks/allocation —
    so it is safe to use even when a runner forks from a worker thread."""
    mem_bytes = mem_mb * 1024 * 1024

    def _apply() -> None:
        # RLIMIT_AS is reliably enforced on Linux (the deploy target). macOS
        # rejects lowering it below the forked interpreter's own mapped size, so
        # only set it on Linux — dev machines don't need the memory fence, and
        # CPU/core limits still apply everywhere.
        if sys.platform.startswith("linux") and hasattr(resource, "RLIMIT_AS"):
            resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
        if hasattr(resource, "RLIMIT_CPU"):
            resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return _apply


LINUX = sys.platform.startswith("linux")
