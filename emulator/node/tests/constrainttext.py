"""Read an enumerated CHECK constraint out of the migrations, as text.

The pack's schema restates several application allowlists as
`check (column in ('a','b',...))`. The database enforces the SQL copy; the
Python copy is what the bridge actually writes. When they disagree the failure
is a 500 from Postgres, in production only — that is the shape of #73, where
`sessions.surface` listed three surfaces and the bridge minted six.

`test_session_surfaces.py` (PR #73) closed that gap for one column by reading
the migrations as TEXT and comparing lists. This module is that reader, lifted
out so `test_check_constraints.py` can apply it to the other enumerated
columns without growing a second parser. It is deliberately crude: no
database, no introspection, one regular expression per fact. A test that read
the constraint from a live schema would need a database and would skip exactly
where it matters; a test that fails must be debuggable by reading the SQL.

Rules, matching what `db/apply.sh` (real-wopr) and `tests/pgharness.py` do:
every `*.sql` in filename order, forward-only, so the LAST definition of a
column's list is the one the database ends up with — whether it was declared
inline on the column in `create table` or restated by `alter table ... add
constraint`.
"""
from __future__ import annotations

import re

import pgharness  # sibling test module; owns the migrations path

# `check (column in ('x', 'y'))` — inline on a column or in an ADD CONSTRAINT.
_CHECK_IN = re.compile(r"check\s*\(\s*(\w+)\s+in\s*\((.*?)\)\s*\)", re.S | re.I)
# The statement that owns a CHECK: the table being created or altered.
_TABLE = re.compile(
    r"\b(?:create\s+table\s+(?:if\s+not\s+exists\s+)?|alter\s+table\s+)(\w+)", re.I)


def migrations_text() -> str:
    """Every migration, in apply order, with `--` comments removed so prose
    about a constraint is never mistaken for the constraint."""
    sql = "\n".join(p.read_text() for p in pgharness.migration_files())
    return re.sub(r"--[^\n]*", "", sql)


def constraint_values(table: str, column: str) -> set[str]:
    """The values `table.column`'s `in (...)` CHECK allows after every
    migration has been applied — the newest definition wins."""
    sql = migrations_text()
    found: list[str] = []
    for m in _CHECK_IN.finditer(sql):
        if m.group(1).lower() != column.lower():
            continue
        owners = _TABLE.findall(sql[:m.start()])
        if owners and owners[-1].lower() == table.lower():
            found.append(m.group(2))
    assert found, (
        f"no `check ({column} in (...))` on table {table} in {pgharness.MIGRATIONS}"
    )
    return set(re.findall(r"'([^']+)'", found[-1]))
