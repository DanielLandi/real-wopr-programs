"""Suite-wide preconditions.

Two modules open with a module-level ``pytest.importorskip("anthropic")``:
``test_joshua_claude.py`` and ``test_joshua_claude_seeks.py``. That skip is
correct for a contributor who ran ``pip install -e '.[dev]'`` and has no reason
to install a production client — but it is also invisible, and CI ran on
``[dev]`` for months while reporting a green suite over five tests that never
executed (#78 item 4).

So the CI job that is supposed to cover them says so, by setting
``WOPR_REQUIRE_PROD_EXTRAS=1``. With the flag set, a missing prod extra is a
usage error raised before a single test runs — it cannot be mistaken for a test
failure, and it cannot scroll past in a field of dots. With the flag unset
(every local run, every other job) behaviour is exactly as it was: the two
modules skip and say why.

The flag is opt-in rather than default-on precisely so the documented skip
stays available to a plain ``[dev]`` install.
"""

from __future__ import annotations

import importlib.util
import os

import pytest

#: The optional-dependency extras `pyproject.toml` calls `prod`. Only these:
#: `dev` is not optional for anyone running the suite, so a missing member of it
#: fails at collection on its own.
PROD_EXTRAS = ("anthropic", "asyncpg")

REQUIRE_FLAG = "WOPR_REQUIRE_PROD_EXTRAS"


def pytest_configure(config: pytest.Config) -> None:
    if os.environ.get(REQUIRE_FLAG) != "1":
        return
    missing = [m for m in PROD_EXTRAS if importlib.util.find_spec(m) is None]
    if missing:
        raise pytest.UsageError(
            f"{REQUIRE_FLAG}=1 says this run must cover the production engines, "
            f"but {', '.join(missing)} {'is' if len(missing) == 1 else 'are'} not "
            "installed. Every module gated on them would skip and the run would "
            "still be green. Install with:\n"
            "    pip install -e 'emulator/node[dev,prod]'\n"
            f"or unset {REQUIRE_FLAG} to accept the skips."
        )
