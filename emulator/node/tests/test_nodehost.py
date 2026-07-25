"""Node host tests, against a fake relay.

The node host dials its relay outbound and claims the lines it answers, then
serves calls by driving its program subprocess-per-turn. These tests stand up a
real WebSocket server playing the relay's part, so the host is exercised over an
actual socket without needing the relay implementation.

Sync tests wrapping asyncio.run(flow()) — the same shape test_runner.py and
test_systemrunner.py use, so no new test dependency.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
import websockets

from app.nodehost import NodeHost, NodeHostError
from test_peercall import FakeDialTarget
from app.topology import load_topology

PACK = Path(__file__).resolve().parent.parent.parent.parent


class FakeRelay:
    """Accepts one node, records its REGISTER, and lets a test drive calls."""

    def __init__(self):
        # A node opens ONE connection per network it declares, each with its own
        # REGISTER. Keeping only the last one is a race the CI runner will win
        # differently from a laptop, so collect them all and index by network.
        self.registrations: list[dict] = []
        self.frames: list[dict] = []
        self._socks: dict[str, object] = {}
        self._server = None
        self._ready = asyncio.Event()

    async def __aenter__(self):
        async def handler(ws):
            # The relay has two legs. /dial is where a peer call arrives; with
            # nobody holding the line, it closes exactly as the real relay does.
            if ws.request.path.startswith("/dial"):
                await ws.close(1000, "NO ANSWER")
                return
            try:
                async for raw in ws:
                    f = json.loads(raw)
                    if f["t"] == "REGISTER":
                        self.registrations.append(f)
                        for c in f["claims"]:
                            self._socks[c["network"]] = ws
                        await ws.send(json.dumps({"t": "REGISTERED", "node": f["node"]}))
                        self._ready.set()
                    else:
                        self.frames.append(f)
            except websockets.ConnectionClosed:
                pass

        self._server = await websockets.serve(handler, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *exc):
        self._server.close()
        await self._server.wait_closed()

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def wait_registered(self, networks=("pstn",), timeout=5.0):
        """Wait until every named network has registered, not merely the first."""
        async def _wait():
            while not all(n in self._socks for n in networks):
                await asyncio.sleep(0.02)
        await asyncio.wait_for(_wait(), timeout)

    @property
    def claims(self) -> set[tuple[str, str]]:
        return {(c["network"], c["address"])
                for r in self.registrations for c in r["claims"]}

    @property
    def node_names(self) -> set[str]:
        return {r["node"] for r in self.registrations}

    async def send(self, frame: dict, network: str = "pstn"):
        """Send down the connection that registered `network` — a node has one
        socket per network, and a RING must arrive on the right one."""
        await self._socks[network].send(json.dumps(frame))

    async def wait_frames(self, n: int, timeout=15.0):
        async def _wait():
            while len(self.frames) < n:
                await asyncio.sleep(0.02)
        await asyncio.wait_for(_wait(), timeout)
        return self.frames

    def display_text(self) -> str:
        return "\n".join(f.get("data", "") for f in self.frames if f["t"] == "FRAME")


def decl_for(node_id: str):
    return load_topology(PACK).nodes[node_id]


def test_the_host_claims_the_lines_its_declaration_names():
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered(("pstn", "bus"))
            assert relay.node_names == {"school"}
            assert ("pstn", "(206) 555-0142") in relay.claims
            assert ("bus", "SCHOOL") in relay.claims
            await host.stop()

    asyncio.run(flow())


def test_a_ring_is_answered_and_the_program_greets():
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)

            assert any(f["t"] == "ANSWER" for f in relay.frames)
            assert "GOOSE LAKE" in relay.display_text()
            await host.stop()

    asyncio.run(flow())


def test_input_drives_the_program_and_its_display_comes_back():
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            # The school's password is PENCIL; a wrong one reprompts.
            await relay.send({"t": "FRAME", "call": 1, "data": "WRONG"})
            await relay.wait_frames(1)
            assert "INVALID PASSWORD" in relay.display_text()
            await host.stop()

    asyncio.run(flow())


def test_the_program_can_end_the_call_itself():
    """Three wrong passwords locks the terminal: LINE DROP becomes a CLOSE."""
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            for _ in range(3):
                await relay.send({"t": "FRAME", "call": 1, "data": "WRONG"})
                await asyncio.sleep(0.5)

            assert any(f["t"] == "CLOSE" for f in relay.frames), relay.frames
            await host.stop()

    asyncio.run(flow())


def test_a_node_that_is_not_declared_refuses_to_start():
    with pytest.raises(NodeHostError, match="not a declared node"):
        NodeHost.for_node("ghost", PACK, {})


def test_the_host_refuses_a_topology_with_errors(monkeypatch):
    """A validation error means the federation is mis-declared; do not spawn."""
    import app.nodehost as nh
    from app.topology import Address

    def broken(_root):
        t = load_topology(PACK)
        school = t.nodes["school"]
        object.__setattr__(school, "networks", dict(
            school.networks,
            ghostnet=Address(network="ghostnet", address="X", protocol="SYSTEM/1"),
        ))
        return t

    monkeypatch.setattr(nh, "load_topology", broken)
    with pytest.raises(NodeHostError, match="unknown-network"):
        NodeHost.for_node("school", PACK, {})


def test_a_program_that_asks_for_a_peer_is_resumed_with_the_answer():
    """The whole point: a CALL becomes a real dial to another process, and the
    program is re-invoked with what came back."""
    from app.systemwire import Call, SystemResponse

    class CallingRunner:
        """Turn 1 asks for a peer; turn 2 (RESUME) reports what it got."""
        def __init__(self):
            self.replies = []

        async def run(self, sid, command, state, user_input, timeout_s=None, reply=None):
            if command == "CONNECT":
                return SystemResponse(sid, "PHASE=MENU", "READY", "UP")
            if reply is None:
                return SystemResponse(
                    sid, "PHASE=AWAIT", "SEARCHING...", "UP",
                    call=Call(peer="school-db", payload="LOOKUP GRADE 1 BIOLOGY 2"))
            self.replies.append(reply)
            body = reply.payload if reply.status == "OK" else "RECORDS UNAVAILABLE"
            return SystemResponse(sid, "PHASE=MENU", body, "UP")

    async def flow():
        async with FakeRelay() as relay, FakeDialTarget(answer="GRADE F") as store:
            runner = CallingRunner()
            host = NodeHost(decl_for("school"), PACK,
                            {"pstn": relay.url, "bus": store.url},
                            system_runner=runner)
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            await relay.send({"t": "FRAME", "call": 1, "data": "GRADES"})
            await relay.wait_frames(2)

            text = relay.display_text()
            assert "SEARCHING..." in text, text   # shown while the call is in flight
            assert "GRADE F" in text, text        # and the peer's answer after it
            assert runner.replies[0].status == "OK"
            await host.stop()

    asyncio.run(flow())


def test_a_dead_peer_degrades_instead_of_hanging():
    from app.systemwire import Call, SystemResponse

    class CallingRunner:
        async def run(self, sid, command, state, user_input, timeout_s=None, reply=None):
            if command == "CONNECT":
                return SystemResponse(sid, "", "READY", "UP")
            if reply is None:
                return SystemResponse(sid, "", "SEARCHING...", "UP",
                                      call=Call(peer="school-db", payload="LOOKUP"))
            body = reply.payload if reply.status == "OK" else "RECORDS UNAVAILABLE"
            return SystemResponse(sid, "", body, "UP")

    async def flow():
        # The bus relay is up and school registers on it; there is simply no
        # store holding SCHOOL-DB, so the dial gets NO ANSWER.
        async with FakeRelay() as relay, FakeRelay() as bus:
            host = NodeHost(decl_for("school"), PACK,
                            {"pstn": relay.url, "bus": bus.url},
                            system_runner=CallingRunner())
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            await relay.send({"t": "FRAME", "call": 1, "data": "GRADES"})
            await relay.wait_frames(2)
            assert "RECORDS UNAVAILABLE" in relay.display_text()
            await host.stop()

    asyncio.run(flow())
