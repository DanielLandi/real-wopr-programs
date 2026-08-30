# The store contract runs against a real Postgres — design

Date: 2026-08-29
Status: approved (design, spec and implementation pre-approved by Daniel)
Issue: [real-wopr-programs#83](https://github.com/DanielLandi/real-wopr-programs/issues/83)

`sessions.surface` carries a CHECK constraint, and that constraint — not
`DEFAULT_LINKS`, not the relay's `surface_links` — is the copy the database
enforces. It is the copy that drifted in #73, and the drift was invisible
because nothing in the suite has ever asked a real database what it accepts.

#73 answered with `test_session_surfaces.py`, which reads all three lists **as
text** and compares them. That proves the lists agree. It cannot prove the
constraint *as applied to a database* accepts what the application sends: a
migration that is syntactically fine, textually consistent, and never applied
passes it.

This change makes the store contract suite run against a migrated Postgres, and
makes "every surface in `DEFAULT_LINKS` mints" one of its assertions.

## What was actually found

The issue proposes standing up a Postgres service container in the `node` job.
That container has existed since #63. `emulator/node/tests/pgharness.py` and the
`postgres` leg of `tests/test_store_contract.py` came with it, and CI has been
running nineteen store-contract tests against real Postgres for weeks.

The defect is one line of that harness:

```python
SCHEMA = pathlib.Path(__file__).resolve().parents[1] / "db" / "migrations" / "0001_init.sql"
```

It names the baseline **file**, not the migrations **directory**. `0002_session_surfaces.sql`
— the migration #73 added to fix the drift — has never been applied to the CI
database. Reproduced locally against Postgres 16.14 on 2026-08-29:

```
$ psql -tAc "select pg_get_constraintdef(oid) from pg_constraint
             where conname='sessions_surface_check'"
CHECK ((surface = ANY (ARRAY['home-terminal'::text, 'norad-terminal'::text, 'norad-bigboard'::text])))

$ python -m pytest tests/test_store_contract.py -q
19 passed in 0.16s
```

Nineteen green tests against a database still carrying the exact three-surface
constraint the issue is about. The suite never mints a fourth surface, so it
never asks the question, and the constraint the fix replaced is still the one
in the test database. Both halves of the bug — the schema that is not the
current schema, and the assertion nobody wrote — are live right now.

So this is not "add Postgres to CI". It is: fix the applier so the test database
is the schema the pack actually ships, then write the assertion that the applied
schema was there for.

## Decisions

1. **The harness applies the migrations directory, forward-only, not a named
   baseline file.** `pgharness` grows `apply_migrations(url)`, which walks
   `db/migrations/*.sql` in sorted order and applies each version exactly once,
   recorded in a `schema_migrations` table. That is deliberately the same
   contract as the engine repo's `db/apply.sh`: version rows, forward-only, no
   downs. The point of contact between the two is a *directory listing*, not a
   list of filenames — so the thing that drifted here (a hard-coded file) cannot
   exist in either. Adding `0003_*.sql` requires editing nothing.

2. **The pack does not gain a second production applier.** `db/apply.sh` lives
   in the engine repo (`real-wopr`) and stays there; the pack owns the
   migrations, the engine owns applying them to Neon. A test harness in this
   repo cannot invoke a script from a sibling checkout, so it reimplements the
   *contract* — apply once, in order, tracked by version — in forty lines of
   Python. That is a duplicated behaviour, and it is worth naming as one: the
   honest fix is for the applier to live beside the migrations it applies, which
   is a cross-repo move and out of scope here. What matters is that the
   duplicated thing is a *rule* and not a *list*, because it was the list that
   broke.

3. **`truncate_all` derives its tables from the database.** The old version
   carried a hard-coded seven-name tuple — a fourth copy of a schema fact, in
   the same file as the third. It now reads `pg_tables` for the public schema
   and excludes `schema_migrations`. A new table in `0003` is truncated between
   tests without anyone remembering to add it.

4. **The assertion is "every `DEFAULT_LINKS` surface mints", parameterised over
   both stores.** `test_every_default_link_surface_mints` iterates
   `DEFAULT_LINKS` and calls `create_session` for each. On `MemoryStore` it is
   nearly free and asserts the store keeps what it was given; on `PostgresStore`
   it is the check that would have caught #73 on the day the surface was added,
   because a surface outside the CHECK raises `asyncpg.CheckViolationError` and
   the test goes red with the constraint's own name in the message.

   It iterates `DEFAULT_LINKS` rather than a literal list of six surfaces on
   purpose. A literal would be a *fifth* copy, and would keep passing on the day
   somebody adds the seventh surface — which is precisely the failure mode of
   every other copy in this story.

5. **The applier gets its own regression test, and it does not ask the applier
   what it applied.** `test_the_test_database_is_the_schema_the_pack_ships`
   globs `db/migrations/` directly and asserts every version has a row in
   `schema_migrations`. Comparing against `pgharness.migration_files()` would be
   a tautology — the defect *was* in that function — so the test reads the
   directory itself. Verified: with the pre-fix one-file applier restored, this
   test fails naming `0002_session_surfaces`, while all three text comparisons
   stay green.

6. **A missing database is a hard failure in CI and a clean skip locally, using
   the flag #78 already established.** `tests/conftest.py` already refuses to
   run when `WOPR_REQUIRE_PROD_EXTRAS=1` and a production extra is absent. That
   flag is set in exactly one place — the `node` job — and it means "this run is
   the one that covers the production engines". A database is a production
   engine; `asyncpg` being importable proves nothing about whether it has
   anything to talk to.

   So the same guard now also requires `WOPR_TEST_DATABASE_URL` to be set **and
   to accept a connection**, and raises `pytest.UsageError` if not — before a
   single test runs, so it cannot be mistaken for a test failure and cannot
   scroll past in a field of dots. With the flag unset (every local run, every
   other job) behaviour is unchanged: no URL means the `postgres` fixture param
   is never generated, the memory leg runs, and the two `skipif`-marked
   Postgres-only tests skip and say why.

   No new environment variable. One flag already means the thing this needs to
   mean, and a second one would be a second thing to forget to set — which is
   how the run goes green for the wrong reason again.

7. **`test_session_surfaces.py` keeps its text comparison, and its docstring is
   rewritten.** Deleting it would be the tidy move and it is wrong, for three
   reasons:

   - **It reaches somewhere the database test cannot.** The relay's
     `surface_links` is TypeScript. No Python test holding a Postgres
     connection can see it, and the `relay` job's own suite has no idea
     `DEFAULT_LINKS` exists. The bridge↔relay direction — the original piece A'
     bug, where every machine call was refused `400 unknown surface` — is
     covered by text comparison or by nothing.
   - **It is the only check on the constraint being *wider* than the code.** A
     mint test can only find surfaces the database rejects. A constraint listing
     a surface no code path mints is not a failure, but it is a lie about what
     the system accepts, and it hides the next drift.
   - **It runs where the real test does not.** A contributor with no Docker gets
     the text comparison and a clear message naming the missing surface, in
     milliseconds, in the `devkit` job as well as the `node` one. Fast-fail
     ahead of a slow real check is a normal and good arrangement.

   What must change is its docstring, which currently argues that a test reading
   the constraint from a database "would be skipped exactly where it matters".
   After this change that is false, and left standing it would tell the next
   reader the real test does not exist. It is rewritten to say what the file now
   is: the cheap, environment-free half, with the expensive half named.

## What runs where, after this

| | text comparison | store contract, memory | store contract, Postgres |
|---|---|---|---|
| local, no database | runs | runs | fixture param not generated; 2 tests skip |
| local, `WOPR_TEST_DATABASE_URL` set | runs | runs | runs |
| CI `node` job | runs | runs | runs, or the job dies with a `UsageError` |
| CI `devkit` job | runs | runs | n/a |

## Out of scope, named

- **The applier lives in the wrong repo** (decision 2). Moving `db/apply.sh`
  into `emulator/node/db/` and having the engine call the pack's copy would
  delete the duplication rather than manage it.
- **The other enumerated CHECK constraints** — `event_logs.kind`,
  `event_logs.actor`, `game_states.status`, `exchanges.joshua` — are the same
  shape of hazard as `sessions.surface`: a list in SQL and a list in Python that
  nothing compares. This change deliberately does not sweep them, per the
  issue's instruction to design toward the surface assertion rather than generic
  coverage. They are worth an issue.
