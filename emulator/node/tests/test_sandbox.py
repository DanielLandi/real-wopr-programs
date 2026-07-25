"""The subprocess resource fence (app/sandbox.py)."""
import subprocess
import sys

import pytest

from app import sandbox


@pytest.mark.skipif(not sandbox.LINUX, reason="RLIMIT_AS is only applied on Linux")
def test_preexec_sets_the_address_space_cap():
    """preexec applies RLIMIT_AS to the configured cap on Linux — the child reads
    its own rlimit back."""
    r = subprocess.run(
        [sys.executable, "-c",
         "import resource; print(resource.getrlimit(resource.RLIMIT_AS)[0])"],
        preexec_fn=sandbox.preexec(300), capture_output=True, text=True)
    assert r.returncode == 0
    assert r.stdout.strip() == str(300 * 1024 * 1024)


@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is enforced on Linux")
def test_memory_cap_is_enforced_on_linux():
    """A child allocating far past its cap is refused, not granted — the
    'allocate GBs and take down the box' failure is contained."""
    r = subprocess.run(
        [sys.executable, "-c", "bytearray(8 * 1024 * 1024 * 1024)"],
        preexec_fn=sandbox.preexec(256), capture_output=True, text=True)
    assert r.returncode != 0  # MemoryError under the cap, not a granted 8 GB
