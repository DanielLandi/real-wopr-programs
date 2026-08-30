"""Shared Postgres test plumbing.

The Postgres leg of the store contract tests runs only when
WOPR_TEST_DATABASE_URL is set (CI provides a services container; locally:
  docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=wopr postgres:16
  export WOPR_TEST_DATABASE_URL=postgresql://postgres:wopr@localhost:5433/postgres
). Without it those tests skip — same convention as tests/test_api.py.

In CI the skip is not available: `WOPR_REQUIRE_PROD_EXTRAS=1` (set only by the
`node` job) makes an absent or unreachable database a usage error raised before
collection, so the run cannot be green over a Postgres leg that never executed.
See tests/conftest.py.

**This module applies the migrations DIRECTORY, not a named baseline file.**
That distinction is the whole point of #83. Until it was fixed, `SCHEMA` here
pointed at `0001_init.sql` alone, so `0002_session_surfaces.sql` — the
migration that widened `sessions_surface_check` from three surfaces to six —
had never been applied to any test database. Nineteen contract tests passed
against a schema carrying the exact constraint #73 was written to replace.
A hard-coded filename is a copy of a fact that lives better in a listing.

The apply contract mirrors the engine repo's `db/apply.sh` (real-wopr): every
`*.sql` in version order, each applied exactly once, recorded in
`schema_migrations`, forward-only, no downs. The two implementations share no
list of files — both read the directory — so the thing that broke cannot break
in either.
"""
from __future__ import annotations

import asyncio
import os
import pathlib

MIGRATIONS = pathlib.Path(__file__).resolve().parents[1] / "db" / "migrations"

#: URLs whose migrations this process has already applied. Applying is
#: idempotent (below), but the store fixture runs per test and a round trip
#: per migration per test is pure latency.
_applied: set[str] = set()


def pg_url() -> str | None:
    return os.environ.get("WOPR_TEST_DATABASE_URL") or None


def migration_files() -> list[pathlib.Path]:
    """Every migration, in the order the database must see them.

    Sorted by filename, which is what the `NNNN_name.sql` convention is for
    and what `db/apply.sh` does with its glob.
    """
    files = sorted(MIGRATIONS.glob("*.sql"))
    assert files, f"no migrations found in {MIGRATIONS}"
    return files


def apply_migrations(url: str, force: bool = False) -> None:
    """Bring `url` up to the pack's current schema, forward-only.

    Each version is applied at most once per database, tracked in
    `schema_migrations` exactly as `db/apply.sh` tracks it — so a long-lived
    local container picks up only what is new, and a fresh CI container gets
    everything.
    """
    if url in _applied and not force:
        return

    import asyncpg

    async def run() -> None:
        conn = await asyncpg.connect(url)
        try:
            await conn.execute(
                "create table if not exists schema_migrations ("
                " version text primary key,"
                " applied_at timestamptz not null default now())")
            for path in migration_files():
                version = path.stem
                seen = await conn.fetchval(
                    "select 1 from schema_migrations where version = $1", version)
                if seen:
                    continue
                # One transaction per migration, like `apply.sh`'s `psql -1`:
                # a file that fails halfway leaves no version row and no
                # half-applied schema.
                async with conn.transaction():
                    await conn.execute(path.read_text())
                    await conn.execute(
                        "insert into schema_migrations (version) values ($1)",
                        version)
        finally:
            await conn.close()

    asyncio.run(run())
    _applied.add(url)


#: Not data: the applier's own bookkeeping. Truncating it would make the next
#: apply_migrations() replay every migration against a schema that has them.
BOOKKEEPING = ("schema_migrations",)


def truncate_all(url: str) -> None:
    """Empty every data table in `public`, reading the list from the database.

    The list used to be a hard-coded seven-name tuple in this file — a second
    copy of a schema fact, in the same module as the copy that drifted (#83).
    A table added by a future migration is now emptied between tests with
    nobody remembering to come back here.

    This empties the whole `public` schema, so WOPR_TEST_DATABASE_URL must
    point at a scratch database. It always had to: the old version dropped the
    contents of all seven application tables.
    """
    import asyncpg

    async def run() -> None:
        conn = await asyncpg.connect(url)
        try:
            rows = await conn.fetch(
                "select tablename from pg_tables where schemaname = 'public'")
            tables = [r["tablename"] for r in rows if r["tablename"] not in BOOKKEEPING]
            if not tables:
                return
            await conn.execute(
                "truncate {} restart identity cascade".format(", ".join(tables)))
        finally:
            await conn.close()

    asyncio.run(run())
