"""Peer-call tests: what happens when a program asks for another machine.

The happy path matters less than the failure paths. A subsystem being down was
an ordinary Tuesday in 1983, and the honest behaviour is a period error message
rather than a hang — so every way a call can fail gets its own test.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import websockets

from app.peercall import execute_call
from app.systemwire import Call
from app.topology import load_topology

PACK = Path(__file__).resolve().parent.parent.parent.parent
TOPO = load_topology(PACK)


class FakeDialTarget:
    """Plays the relay's caller leg: greets, then answers one request.

    Mirrors what startNetworkRelay does — Envelopes out, raw text in, `eom`
    marking the end of each application message.
    """

    def __init__(self, *, answer: str = "GRADE F", greet: str = "READY",
                 answer_delay: float = 0.0, refuse: bool = False,
                 drop_after_greet: bool = False):
        self.answer = answer
        self.greet = greet
        self.answer_delay = answer_delay
        self.refuse = refuse
        self.drop_after_greet = drop_after_greet
        self.received: list[str] = []

    async def __aenter__(self):
        async def handler(ws):
            if self.refuse:
                await ws.close(1000, "NO ANSWER")
                return
            await self._say(ws, self.greet)
            if self.drop_after_greet:
                await ws.close(1000, "NO CARRIER")
                return
            try:
                async for raw in ws:
                    self.received.append(raw)
                    if self.answer_delay:
                        await asyncio.sleep(self.answer_delay)
                    await self._say(ws, self.answer)
            except websockets.ConnectionClosed:
                pass

        self._server = await websockets.serve(handler, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        await self._server.wait_closed()

    async def _say(self, ws, text: str):
        await ws.send(json.dumps({
            "v": 1, "session": "t", "seq": 1, "kind": "output",
            "link": "bus", "payload": text, "eom": True,
        }))

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"


def school() -> object:
    return TOPO.nodes["school"]


def test_a_peer_the_node_never_declared_is_never_dialled():
    """A program cannot invent a peer: the reach is the manifest's to grant."""
    async def flow():
        reply = await execute_call(
            Call(peer="pentagon", payload="LAUNCH"),
            school(), TOPO, relays={}, caller="school",
        )
        assert reply.status == "FAIL"
        assert reply.payload == ""

    asyncio.run(flow())


def test_a_successful_call_comes_back_OK_with_the_peer_s_answer():
    async def flow():
        async with FakeDialTarget(answer="GRADE F") as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP GRADE 1 BIOLOGY 2"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
            )
            assert reply.status == "OK"
            assert reply.payload == "GRADE F"
            assert reply.peer == "school-db"
            # The payload reached the peer verbatim.
            assert "LOOKUP GRADE 1 BIOLOGY 2" in target.received[0]

    asyncio.run(flow())


def test_a_multi_line_answer_survives_intact():
    async def flow():
        async with FakeDialTarget(answer="GRADE F\nTERM SPRING-83") as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP GRADE 1 BIOLOGY 2"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
            )
            assert reply.payload == "GRADE F\nTERM SPRING-83"

    asyncio.run(flow())


def test_an_unreachable_relay_is_a_clean_FAIL():
    async def flow():
        reply = await execute_call(
            Call(peer="school-db", payload="LOOKUP GRADE 1 BIOLOGY 2"),
            school(), TOPO, relays={"bus": "ws://127.0.0.1:1"}, caller="school",
        )
        assert reply.status == "FAIL"

    asyncio.run(flow())


def test_no_answer_from_the_line_is_a_FAIL():
    async def flow():
        async with FakeDialTarget(refuse=True) as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
            )
            assert reply.status == "FAIL"

    asyncio.run(flow())


def test_a_peer_that_answers_then_drops_is_a_FAIL():
    async def flow():
        async with FakeDialTarget(drop_after_greet=True) as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
            )
            assert reply.status == "FAIL"

    asyncio.run(flow())


def test_a_slow_peer_is_a_TIMEOUT_not_a_hang():
    async def flow():
        async with FakeDialTarget(answer_delay=2.0) as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
                timeout_s=0.3,
            )
            assert reply.status == "TIMEOUT"

    asyncio.run(flow())


def test_exceeding_the_call_depth_is_a_FAIL_without_dialling():
    async def flow():
        async with FakeDialTarget() as target:
            reply = await execute_call(
                Call(peer="school-db", payload="LOOKUP"),
                school(), TOPO, relays={"bus": target.url}, caller="school",
                depth=4,
            )
            assert reply.status == "FAIL"
            assert target.received == []

    asyncio.run(flow())


def test_a_peer_sharing_no_network_is_a_FAIL():
    """reference is on pstn and norad; school is on pstn and bus — but school
    does not declare reference as a peer, so this is refused at the manifest."""
    async def flow():
        reply = await execute_call(
            Call(peer="reference", payload="ANYTHING"),
            school(), TOPO, relays={}, caller="school",
        )
        assert reply.status == "FAIL"

    asyncio.run(flow())
