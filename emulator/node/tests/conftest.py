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

The same flag now also requires a **reachable database** (#83). ``asyncpg``
being importable proves nothing about whether it has anything to talk to: with
``WOPR_TEST_DATABASE_URL`` unset, ``tests/test_store_contract.py`` simply never
generates its ``postgres`` fixture parameter, so the Postgres leg vanishes
without even a skip line to notice. A database is a production engine, and this
is the run that is supposed to cover it — so an absent or unreachable one is the
same usage error, raised the same way, for the same reason.
"""

from __future__ import annotations

import asyncio
import importlib.util
import os

import pytest

#: The optional-dependency extras `pyproject.toml` calls `prod`. Only these:
#: `dev` is not optional for anyone running the suite, so a missing member of it
#: fails at collection on its own.
PROD_EXTRAS = ("anthropic", "asyncpg")

REQUIRE_FLAG = "WOPR_REQUIRE_PROD_EXTRAS"

#: The scratch database the Postgres leg of the store contract runs against.
#: CI's `node` job points it at a services container; see tests/pgharness.py.
DB_URL_VAR = "WOPR_TEST_DATABASE_URL"


def _require_prod_extras() -> None:
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


def _require_database() -> None:
    """A run claiming to cover the production engines must have a database.

    Not "must have a URL": an unreachable URL produces the identical outcome,
    which is a store contract suite that only ever exercised MemoryStore —
    the condition #73's drift hid behind.
    """
    url = os.environ.get(DB_URL_VAR) or ""
    if not url:
        raise pytest.UsageError(
            f"{REQUIRE_FLAG}=1 says this run must cover the production engines, "
            f"but {DB_URL_VAR} is not set. The Postgres leg of the store "
            "contract would not even be collected — no skip line, no failure, "
            "a green run over the store the exchange actually uses. Start one:\n"
            "    docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=wopr postgres:16\n"
            f"    export {DB_URL_VAR}=postgresql://postgres:wopr@localhost:5433/postgres\n"
            f"or unset {REQUIRE_FLAG} to accept the skips."
        )

    import asyncpg  # guaranteed importable: _require_prod_extras ran first

    async def ping() -> None:
        conn = await asyncpg.connect(url, timeout=10)
        await conn.close()

    try:
        asyncio.run(ping())
    except Exception as exc:  # noqa: BLE001 — any failure to connect is the same failure
        raise pytest.UsageError(
            f"{REQUIRE_FLAG}=1 says this run must cover the production engines, "
            f"but {DB_URL_VAR} does not accept a connection: "
            f"{type(exc).__name__}: {exc}\n"
            "The Postgres leg would silently not run and the suite would still "
            "be green."
        ) from exc


def pytest_configure(config: pytest.Config) -> None:
    if os.environ.get(REQUIRE_FLAG) != "1":
        return
    _require_prod_extras()
    _require_database()
