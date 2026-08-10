"""Shared Postgres test plumbing.

The Postgres leg of the store contract tests runs only when
WOPR_TEST_DATABASE_URL is set (CI provides a services container; locally:
  docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=wopr postgres:16
  export WOPR_TEST_DATABASE_URL=postgresql://postgres:wopr@localhost:5433/postgres
). Without it those tests skip — same convention as tests/test_api.py.
"""
from __future__ import annotations

import asyncio
import os
import pathlib

SCHEMA = pathlib.Path(__file__).resolve().parents[1] / "db" / "migrations" / "0001_init.sql"

TABLES = ("event_logs", "session_system_state", "game_states", "sessions",
          "operator_clearances", "rooms", "exchanges")


def pg_url() -> str | None:
    return os.environ.get("WOPR_TEST_DATABASE_URL") or None


def apply_schema(url: str) -> None:
    import asyncpg

    async def run() -> None:
        conn = await asyncpg.connect(url)
        try:
            await conn.execute(SCHEMA.read_text())
        finally:
            await conn.close()

    asyncio.run(run())


def truncate_all(url: str) -> None:
    import asyncpg

    async def run() -> None:
        conn = await asyncpg.connect(url)
        try:
            await conn.execute("truncate {} cascade".format(", ".join(TABLES)))
        finally:
            await conn.close()

    asyncio.run(run())
