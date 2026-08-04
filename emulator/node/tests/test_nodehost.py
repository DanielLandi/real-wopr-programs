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
    # `school` used to be the pack's one multi-network node (pstn + bus) and
    # served as this test's example; Task 7 narrowed it to `bus` only (its
    # phone line moves to school-mon). `reference` (pstn + norad) is now the
    # multi-network case, so the claims-plural story moves to it.
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("reference"), PACK, {"pstn": relay.url, "norad": relay.url})
            await host.start()
            await relay.wait_registered(("pstn", "norad"))
            assert relay.node_names == {"reference"}
            assert ("pstn", "(311) 555-0101") in relay.claims
            assert ("norad", "REFERENCE") in relay.claims
            await host.stop()

    asyncio.run(flow())


def test_a_ring_is_answered_and_the_program_greets():
    # `school` no longer answers a phone line directly (Task 7 moved that to
    # school-mon, next task), so this generic RING/ANSWER/greeting mechanic
    # moves to `reference`, which is unaffected by the split.
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("reference"), PACK, {"pstn": relay.url, "norad": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "3115550101"})
            await relay.wait_frames(2)

            assert any(f["t"] == "ANSWER" for f in relay.frames)
            assert "REFERENCE SYSTEM READY" in relay.display_text()
            await host.stop()

    asyncio.run(flow())


def test_input_drives_the_program_and_its_display_comes_back():
    # `school` no longer answers a phone line directly (Task 7 moved that to
    # school-mon), so the password reprompt this test drives moves with it —
    # login.bas holds the same PENCIL/wrong-password/reprompt logic
    # records.bas used to.
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school-mon"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            # school-mon's password is PENCIL; a wrong one reprompts.
            await relay.send({"t": "FRAME", "call": 1, "data": "WRONG"})
            await relay.wait_frames(1)
            assert "INVALID PASSWORD" in relay.display_text()
            await host.stop()

    asyncio.run(flow())


def test_the_program_can_end_the_call_itself():
    """Three wrong passwords locks the terminal: LINE DROP becomes a CLOSE.

    Moved to school-mon with the phone line (Task 7/8 split) — the
    three-strikes lockout is login.bas's, not records.bas's."""
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("school-mon"), PACK, {"pstn": relay.url, "bus": relay.url})
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "2065550142"})
            await relay.wait_frames(2)
            relay.frames.clear()

            # Wait for each reprompt before trying again — a fixed sleep
            # loses the race on a slow runner now that the school reloads
            # its data files every spawn.
            for i in range(2):
                await relay.send({"t": "FRAME", "call": 1, "data": "WRONG"})
                await relay.wait_frames(i + 1)
            await relay.send({"t": "FRAME", "call": 1, "data": "WRONG"})

            async def _closed():
                while not any(f["t"] == "CLOSE" for f in relay.frames):
                    await asyncio.sleep(0.02)
            await asyncio.wait_for(_closed(), 15.0)

            assert any(f["t"] == "CLOSE" for f in relay.frames), relay.frames
            await host.stop()

    asyncio.run(flow())


def test_a_prompt_follows_the_display_frame():
    """A response carrying `prompt` sends a PROMPT frame after the FRAME that
    delivers the display, so the input line can repaint the question.

    Uses a fully mocked runner, so which system answers is incidental; moved
    off `school` to `reference` (Task 7 took school's phone line away)."""
    from app.systemwire import SystemResponse

    class PromptingRunner:
        async def run(self, sid, command, state, user_input, timeout_s=None, reply=None):
            return SystemResponse(sid, "", "WELCOME", "UP", prompt="TEST:")

    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("reference"), PACK, {"pstn": relay.url, "norad": relay.url},
                            system_runner=PromptingRunner())
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "3115550101"})
            await relay.wait_frames(3)

            assert [f["t"] for f in relay.frames] == ["ANSWER", "FRAME", "PROMPT"]
            prompt = next(f for f in relay.frames if f["t"] == "PROMPT")
            assert prompt["call"] == 1
            assert prompt["data"] == "TEST:"
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


def _stub_caller_pair(tmp_path, sid="stub-caller", peer="stub-peer"):
    """A purpose-built pair of stub systems for the CALL/RESUME tests below.

    `school` used to carry this coverage, but Task 7 moved its phone line to
    school-mon: `school` is now reachable only over `bus`, the same network
    its peer `school-db` sits on, and no single test double can both register
    a node on a URL and answer as its peer on that same URL. So these tests
    get their own pair instead of reusing a real pack system.

    `stub-caller` is a real subprocess — harness/bin/<id>, the same shape
    test_systemrunner.py's `_write_stub_system` uses, with an explicit
    (unhashed) phone number — rather than a Python `system_runner` double,
    so the CALL/RESUME loop is exercised the way a node host actually drives
    a program. Unlike that helper's static per-command echo, turn 2 (RESUME)
    has to read back whatever status the REPLY block actually carries — OK
    with the peer's payload, or anything else with RECORDS UNAVAILABLE — so
    both tests can share one script. `stub-peer` is never invoked as a
    subprocess (nothing dials it *in*; `execute_call` only ever opens a raw
    `/dial` leg to whatever URL the test wires up for its network), so it is
    just a topology entry, not a second binary.
    """
    from app.topology import Address, NodeDecl, Topology

    bindir = tmp_path / "systems" / sid / "harness" / "bin"
    bindir.mkdir(parents=True)
    script = rf"""#!/usr/bin/env bash
set -uo pipefail
read -r header
cmd=$(printf '%s' "$header" | cut -d' ' -f3)
case "$cmd" in
  CONNECT)
    cat >/dev/null
    printf 'SYSTEM/1 {sid} OK\nSTATE 0\nDISPLAY 1\nREADY\nLINE UP\nEND\n'
    ;;
  INPUT)
    cat >/dev/null
    printf 'SYSTEM/1 {sid} OK\nSTATE 0\nDISPLAY 1\nSEARCHING...\nCALL {peer} 1\nLOOKUP GRADE 1 BIOLOGY 2\nLINE UP\nEND\n'
    ;;
  RESUME)
    read -r _state_hdr
    read -r reply_hdr
    status=$(printf '%s' "$reply_hdr" | cut -d' ' -f3)
    n=$(printf '%s' "$reply_hdr" | cut -d' ' -f4)
    payload=""
    i=0
    while [ "$i" -lt "$n" ]; do
      read -r payload
      i=$((i + 1))
    done
    read -r _end
    if [ "$status" = "OK" ]; then
      body="$payload"
    else
      body="RECORDS UNAVAILABLE"
    fi
    printf 'SYSTEM/1 {sid} OK\nSTATE 0\nDISPLAY 1\n%s\nLINE UP\nEND\n' "$body"
    ;;
  *)
    cat >/dev/null
    printf 'SYSTEM/1 {sid} OK\nSTATE 0\nDISPLAY 1\nPROTOCOL ERROR\nLINE DROP\nEND\n'
    exit 1
    ;;
esac
exit 0
"""
    binary = bindir / sid
    binary.write_text(script)
    binary.chmod(0o755)

    decl = NodeDecl(
        id=sid, title=sid.upper(),
        networks={
            "pstn": Address(network="pstn", address="(555) 010-1000", protocol="SYSTEM/1"),
            "bus": Address(network="bus", address=sid.upper(), protocol="SYSTEM/1"),
        },
        peers=(peer,),
    )
    peer_decl = NodeDecl(
        id=peer, title=peer.upper(),
        networks={"bus": Address(network="bus", address=peer.upper(), protocol="SYSTEM/1")},
    )
    topo = Topology(networks={}, nodes={sid: decl, peer: peer_decl})
    return decl, topo


def test_a_program_that_asks_for_a_peer_is_resumed_with_the_answer(tmp_path):
    """The whole point: a CALL becomes a real dial to another process, and the
    program is re-invoked with what came back."""
    decl, topo = _stub_caller_pair(tmp_path)

    async def flow():
        async with FakeRelay() as relay, FakeDialTarget(answer="GRADE F") as store:
            host = NodeHost(decl, tmp_path, {"pstn": relay.url, "bus": store.url},
                            topology=topo)
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "5550101000"})
            await relay.wait_frames(2)
            relay.frames.clear()

            await relay.send({"t": "FRAME", "call": 1, "data": "GRADES"})
            await relay.wait_frames(2)

            text = relay.display_text()
            assert "SEARCHING..." in text, text   # shown while the call is in flight
            assert "GRADE F" in text, text        # the peer's answer, verbatim, after it
            await host.stop()

    asyncio.run(flow())


def test_a_dead_peer_degrades_instead_of_hanging(tmp_path):
    decl, topo = _stub_caller_pair(tmp_path)

    async def flow():
        # The bus relay is up and stub-caller registers on it; there is simply
        # no target holding stub-peer's line, so the dial gets NO ANSWER.
        async with FakeRelay() as relay, FakeRelay() as bus:
            host = NodeHost(decl, tmp_path, {"pstn": relay.url, "bus": bus.url},
                            topology=topo)
            await host.start()
            await relay.wait_registered()

            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "5550101000"})
            await relay.wait_frames(2)
            relay.frames.clear()

            await relay.send({"t": "FRAME", "call": 1, "data": "GRADES"})
            await relay.wait_frames(2)
            assert "RECORDS UNAVAILABLE" in relay.display_text()
            await host.stop()

    asyncio.run(flow())


def test_a_persistent_store_remembers_across_separate_calls(tmp_path):
    """school-db is declared state: persistent — the whole point is that a
    second caller sees what the first one wrote."""
    async def flow():
        async with FakeRelay() as bus:
            host = NodeHost(decl_for("school-db"), PACK, {"bus": bus.url},
                            runtime_dir=tmp_path)
            await host.start()
            await bus.wait_registered(("bus",))

            await bus.send({"t": "RING", "call": 1, "from": "school",
                            "network": "bus", "address": "SCHOOL-DB"}, network="bus")
            await bus.wait_frames(2)
            await bus.send({"t": "FRAME", "call": 1,
                            "data": "SET GRADE 1 BIOLOGY 2 A"}, network="bus")
            await bus.wait_frames(3)
            bus.frames.clear()

            # A second, separate call must see the override the first one set.
            await bus.send({"t": "RING", "call": 2, "from": "school",
                            "network": "bus", "address": "SCHOOL-DB"}, network="bus")
            await bus.wait_frames(2)
            bus.frames.clear()
            await bus.send({"t": "FRAME", "call": 2,
                            "data": "LOOKUP GRADE 1 BIOLOGY 2"}, network="bus")
            await bus.wait_frames(1)

            assert "GRADE A" in bus.display_text(), bus.display_text()
            await host.stop()

    asyncio.run(flow())


def test_an_ephemeral_node_writes_no_store_file(tmp_path):
    """A dial-in system with no declared state is not a store; nothing should
    be persisted for it. Moved off `school` to `reference` (Task 7 took
    school's phone line away) — the ephemeral-vs-persistent distinction this
    test pins is generic, not specific to school."""
    async def flow():
        async with FakeRelay() as relay:
            host = NodeHost(decl_for("reference"), PACK,
                            {"pstn": relay.url, "norad": relay.url}, runtime_dir=tmp_path)
            assert host.store is None
            await host.start()
            await relay.wait_registered(("pstn", "norad"))
            await relay.send({"t": "RING", "call": 1, "from": "console",
                              "network": "pstn", "address": "3115550101"})
            await relay.wait_frames(2)
            assert not (tmp_path / "state").exists()
            await host.stop()

    asyncio.run(flow())
