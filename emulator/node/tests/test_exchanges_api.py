"""Phone-book routes. Same TestClient pattern as tests/test_api.py."""
from __future__ import annotations

import asyncio

import pytest
from starlette.testclient import TestClient

from app.config import load_settings
from app.main import create_app
from app.store import MemoryStore


@pytest.fixture()
def client():
    store = MemoryStore()
    app = create_app(settings=load_settings(), store=store)
    c = TestClient(app)
    c.app_store = store
    return c


VALID = {"id": "alpha", "name": "Alpha Exchange", "region": "US-East",
         "api": "https://alpha.example", "link": "wss://alpha.example/link",
         "joshua": "claude", "operator": "op1"}


def test_register_lands_pending(client):
    r = client.post("/api/exchanges/register", json=VALID)
    assert r.status_code == 201
    assert r.json() == {"id": "alpha", "approved": False}
    # pending rows are not listed
    assert client.get("/api/exchanges").json() == {"exchanges": []}
    # store really holds it, unapproved
    assert client.app_store.exchanges["alpha"]["approved"] is False


def test_register_duplicate_409(client):
    assert client.post("/api/exchanges/register", json=VALID).status_code == 201
    assert client.post("/api/exchanges/register", json=VALID).status_code == 409


def test_register_duplicate_does_not_spend_quota(client):
    budget = client.app.state.exchange_register_budget
    assert client.post("/api/exchanges/register", json=VALID).status_code == 201
    remaining_after_success = budget.remaining()
    r = client.post("/api/exchanges/register", json=VALID)
    assert r.status_code == 409
    assert budget.remaining() == remaining_after_success


@pytest.mark.parametrize("patch", [
    {"id": "Bad_ID!"}, {"id": "a"}, {"name": "x"}, {"region": "y"},
    {"api": "http://insecure.example"}, {"link": "https://not-wss.example"},
    {"joshua": "hal9000"},
])
def test_register_validation_422(client, patch):
    assert client.post("/api/exchanges/register", json={**VALID, **patch}).status_code == 422


def test_list_returns_approved(client):
    async def seed():
        await client.app_store.register_exchange(**{k: VALID[k] for k in
            ("id", "name", "region", "api", "link", "joshua", "operator")})
        client.app_store.exchanges["alpha"]["approved"] = True

    asyncio.run(seed())
    body = client.get("/api/exchanges").json()
    assert body == {"exchanges": [{"id": "alpha", "name": "Alpha Exchange",
                                   "region": "US-East", "api": "https://alpha.example",
                                   "link": "wss://alpha.example/link",
                                   "joshua": "claude", "operator": "op1"}]}


def test_register_quota_429(client):
    # burn the daily budget, then expect 429
    budget = client.app.state.exchange_register_budget
    while budget.available():
        budget.spend()
    r = client.post("/api/exchanges/register", json=VALID)
    assert r.status_code == 429
