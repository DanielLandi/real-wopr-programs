"""Every enumerated CHECK constraint has a Python copy; the two must agree.

`sessions.surface` drifted from `DEFAULT_LINKS` and cost a production outage
(#73): the SQL list is the one the database enforces, the Python list is the
one the bridge writes, and nothing compared them. Four more columns had the
same shape and no guard (#91):

    sessions.surface     <->  store.SESSION_SURFACES   (#111)
    event_logs.kind      <->  store.EVENT_KINDS
    event_logs.actor     <->  store.EVENT_ACTORS
    game_states.status   <->  store.GAME_STATUSES
    exchanges.joshua     <->  store.EXCHANGE_JOSHUAS

These tests are the seam. They read the migrations as TEXT (see
`constrainttext.py`, lifted from `test_session_surfaces.py`) and compare each
pair in both directions. The Postgres direction — does the live schema really
accept every Python value — is `test_store_contract.py`, which writes each
value through PostgresStore in CI.

This is a table of hand-declared pairs rather than a walk over the live
schema's constraints, on purpose. The next enumerated column costs one line
here and is missed by nothing else: `MemoryStore` refuses a value outside the
Python set, so an emit site that invents a new kind fails the in-memory suite
long before Postgres sees it.
"""
from __future__ import annotations

from typing import get_args

import pytest

from app.main import DEFAULT_LINKS, RegisterExchange
from app.store import (EVENT_ACTORS, EVENT_KINDS, EXCHANGE_JOSHUAS, GAME_STATUSES,
                       SESSION_SURFACES)
from app.wire import STATUSES as WIRE_STATUSES
from constrainttext import constraint_values

COLUMNS = [
    pytest.param("sessions", "surface", SESSION_SURFACES, id="sessions.surface"),
    pytest.param("event_logs", "kind", EVENT_KINDS, id="event_logs.kind"),
    pytest.param("event_logs", "actor", EVENT_ACTORS, id="event_logs.actor"),
    pytest.param("game_states", "status", GAME_STATUSES, id="game_states.status"),
    pytest.param("exchanges", "joshua", EXCHANGE_JOSHUAS, id="exchanges.joshua"),
]


@pytest.mark.parametrize("table,column,python", COLUMNS)
def test_the_database_accepts_every_value_the_bridge_writes(table, column, python):
    """The outage direction: a value the bridge writes and the constraint
    rejects is a 500 from Postgres, in production only."""
    missing = set(python) - constraint_values(table, column)
    assert not missing, (
        f"{table}.{column}: the bridge writes {sorted(missing)} but the CHECK "
        f"constraint rejects them — add a migration widening it"
    )


@pytest.mark.parametrize("table,column,python", COLUMNS)
def test_the_constraint_names_no_value_the_bridge_does_not_write(table, column, python):
    """The other direction. A constraint wider than the code is not a failure,
    but it is a lie about what the system does, and it hides the next drift."""
    extra = constraint_values(table, column) - set(python)
    assert not extra, (
        f"{table}.{column}: the CHECK constraint allows {sorted(extra)} but "
        f"nothing writes them — narrow it, or declare them in app/store.py"
    )


def test_every_wire_status_is_storable():
    """`GAME_STATUSES` is the wire's STATUS vocabulary plus the bridge's own
    QUIT. If the wire grows a status the store cannot keep, a game the
    program finished cannot be saved."""
    assert set(WIRE_STATUSES) <= GAME_STATUSES
    assert "QUIT" in GAME_STATUSES


def test_the_register_api_offers_exactly_the_engines_the_store_accepts():
    """`RegisterExchange.joshua` is a pydantic Literal — the API's copy of the
    list. It must be the store's copy, or a registration the API accepts
    dies in the database."""
    api = set(get_args(RegisterExchange.model_fields["joshua"].annotation))
    assert api == EXCHANGE_JOSHUAS


def test_the_store_accepts_exactly_the_surfaces_the_bridge_mints():
    """`DEFAULT_LINKS` (main.py) is what `POST /api/session` accepts;
    `SESSION_SURFACES` is what MemoryStore will store. They are two copies
    because store.py cannot import main.py (main imports the store). A
    surface added to one and not the other is either a mint the in-memory
    suite refuses, or a guard with a hole in it (#111)."""
    assert set(DEFAULT_LINKS) == SESSION_SURFACES
