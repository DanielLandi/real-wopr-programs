"""The surface allowlist exists in three places; they must agree.

`DEFAULT_LINKS` (app/main.py) decides what `POST /api/session` accepts.
`surface_links` (relay/src/config.ts) decides what the comms layer paces.
The `sessions_surface_check` CHECK constraint decides what the DATABASE will
store — and that third copy is the one that drifted: `wopr-panel` returned 500
against Neon from the day it was added, and the two machine surfaces could not
mint a session at all, so a machine-placed call died at the database.

None of it surfaced in tests, because the suite ran the in-memory store and
never touched the constraint. So these tests read the migration and the relay's
config as TEXT and compare the lists.

**Text comparison is the cheap half, and it is no longer the only half** (#83).
`test_store_contract.py::test_every_default_link_surface_mints` now mints every
`DEFAULT_LINKS` surface against a real Postgres with every migration applied —
which is the check that proves the constraint, as the database actually holds
it, accepts what the bridge actually sends. A migration that is textually
consistent and never applied passes this file and fails that one.

This file stays, for three things that one cannot do:

- The relay's `surface_links` is TypeScript. No Python test holding a database
  connection can see it, and the `relay` job has never heard of `DEFAULT_LINKS`.
  The bridge/relay direction is covered here or nowhere.
- A mint test can only find surfaces the database REJECTS. A constraint wider
  than the code is not a failure, but it is a lie about what the system accepts,
  and it hides the next drift — that direction is only checked below.
- It runs with no database, in milliseconds, and names the offending surface.
  A contributor with no Docker still gets the fast fail.
"""
from __future__ import annotations

import re
from pathlib import Path

from app.main import DEFAULT_LINKS

PACK = Path(__file__).resolve().parents[3]
MIGRATIONS = PACK / "emulator" / "node" / "db" / "migrations"
RELAY_CONFIG = PACK / "emulator" / "relay" / "src" / "config.ts"


def _constraint_surfaces() -> set[str]:
    """Every surface named by the newest sessions_surface_check in the migrations."""
    sql = "\n".join(
        p.read_text() for p in sorted(MIGRATIONS.glob("*.sql"))
    )
    # The LAST definition wins — migrations are forward-only, so a later file
    # replacing the constraint is the one the database ends up with.
    blocks = re.findall(
        r"constraint\s+sessions_surface_check\s+check\s*\(\s*surface\s+in\s*\((.*?)\)\s*\)",
        sql,
        re.S | re.I,
    )
    assert blocks, "no sessions_surface_check constraint found in the migrations"
    return set(re.findall(r"'([^']+)'", blocks[-1]))


def _relay_surfaces() -> set[str]:
    text = RELAY_CONFIG.read_text()
    block = re.search(r"surface_links:\s*\{(.*?)\n  \}", text, re.S)
    assert block, "surface_links block not found in relay/src/config.ts"
    # Keys only: values are profile names, and comments inside the block are
    # prose that must not be mistaken for entries.
    return set(re.findall(r'^\s*"([^"]+)":', block.group(1), re.M))


def test_the_database_accepts_every_surface_the_bridge_will_mint():
    """The bug this file exists for: a surface the bridge accepts and the
    database rejects is a 500 at session creation, in production only."""
    missing = set(DEFAULT_LINKS) - _constraint_surfaces()
    assert not missing, (
        f"these surfaces mint a session but violate the CHECK constraint: {sorted(missing)} "
        f"— add them to a new migration in {MIGRATIONS.name}/"
    )


def test_the_bridge_mints_every_surface_the_relay_paces():
    """The other direction, and the original piece A' bug: the relay knew both
    machine surfaces and the bridge did not, so every machine call was refused
    `400 unknown surface` against a real bridge."""
    missing = _relay_surfaces() - set(DEFAULT_LINKS)
    assert not missing, (
        f"the relay paces these surfaces but the bridge will not mint them: {sorted(missing)}"
    )


def test_the_constraint_names_no_surface_the_code_does_not():
    """A constraint wider than the code is not a failure, but it is a lie about
    what the system accepts, and it hides the next drift."""
    extra = _constraint_surfaces() - set(DEFAULT_LINKS)
    assert not extra, f"the constraint allows surfaces the bridge cannot mint: {sorted(extra)}"
