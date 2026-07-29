"""One node, one process.

The node host is the harness side of a single `node` declaration. It dials its
relays outbound, claims the lines the pack says it answers, and serves each call
by driving its program subprocess-per-turn — the same SystemRunner the bridge
uses, so a program behaves identically whether it is reached through a node or
through the monolith.

It refuses to start on a topology with validation errors. A mis-declared
federation should fail where it is declared, not halfway through a call.

Scope note: a node whose id is itself a program (school, airline, school-db …)
serves that program directly, which is the common case and the whole of the
school/school-db split. A *composite* host — one that only mounts others, like
WOPR — needs the router, and that wiring lands with the WOPR executive
(DanielLandi/real-wopr#112) rather than being faked here.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import websockets

from .peercall import execute_call
from .storestate import StoreState
from .systemrunner import (
    SystemBusy, SystemFault, SystemRunner, SystemRunnerConfig, SystemTimeout,
)
from .systemwire import Reply
from .systems import System
from .topology import NodeDecl, Topology, load_topology
from .topology_validate import errors, validate

log = logging.getLogger("wopr.nodehost")


class NodeHostError(Exception):
    """The node cannot serve what it was asked to serve."""


@dataclass
class Session:
    """One live call: the opaque STATE this program has built up so far."""
    call: int
    state: str | None = None


class NodeHost:
    def __init__(self, decl: NodeDecl, pack_root: Path, relays: dict[str, str],
                 system_runner: SystemRunner | None = None,
                 topology: Topology | None = None,
                 runtime_dir: Path | None = None):
        self.decl = decl
        self.topology = topology or load_topology(Path(pack_root))
        self.pack_root = Path(pack_root)
        self.relays = relays
        self.sessions: dict[int, Session] = {}
        self._conns: list[websockets.ClientConnection] = []
        self._tasks: list[asyncio.Task] = []
        self._registered = asyncio.Event()

        # A store's STATE belongs to its host, not to whoever called it.
        # Ephemeral nodes keep state per call, in the Session.
        self.store = (
            StoreState(runtime_dir or (self.pack_root / ".wopr"), decl.id)
            if decl.state == "persistent" else None
        )

        systems_dir = self.pack_root / "systems"
        self.runner = system_runner or SystemRunner(
            SystemRunnerConfig(systems_dir=systems_dir),
            {decl.id: System(id=decl.id, title=decl.title, language="", binary=decl.id,
                             number="", timeout_s=None)},
        )

    # ---- construction -------------------------------------------------------

    @classmethod
    def for_node(cls, node_id: str, pack_root: Path, relays: dict[str, str]) -> "NodeHost":
        """Load the topology, refuse a broken one, and resolve this node."""
        pack_root = Path(pack_root)
        topo = load_topology(pack_root)

        pack = json.loads((pack_root / "pack.json").read_text())
        program_ids = {p["id"] for p in pack["programs"]}
        program_paths = {p["id"]: p["path"] for p in pack["programs"]}
        problems = errors(validate(topo, program_ids, program_paths))
        if problems:
            raise NodeHostError(
                "topology has errors, refusing to start:\n  "
                + "\n  ".join(f"{p.code}: {p.message}" for p in problems)
            )

        decl = topo.nodes.get(node_id)
        if decl is None:
            raise NodeHostError(f"{node_id!r} is not a declared node")
        return cls(decl, pack_root, relays, topology=topo)

    # ---- lifecycle ----------------------------------------------------------

    async def start(self) -> None:
        """Connect to every relay this node declares and claim its lines."""
        for network in self.decl.networks:
            url = self.relays.get(network)
            if url is None:
                raise NodeHostError(f"{self.decl.id}: no relay URL for network {network!r}")
            conn = await websockets.connect(f"{url}/node")
            self._conns.append(conn)
            await conn.send(json.dumps({
                "t": "REGISTER", "v": 1, "node": self.decl.id,
                "claims": [{
                    "network": network,
                    "address": self.decl.networks[network].address,
                    "protocol": self.decl.networks[network].protocol,
                }],
                # Who may reach us. The relay enforces this, not the caller —
                # a caller is never trusted to police its own reach.
                "callable_by": list(self.decl.callable_by)
                if self.decl.callable_by is not None else None,
            }))
            self._tasks.append(asyncio.create_task(self._serve(conn, network)))
        await asyncio.wait_for(self._registered.wait(), timeout=10)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for c in self._conns:
            await c.close()
        self._tasks.clear()
        self._conns.clear()

    async def run(self) -> None:
        await self.start()
        await asyncio.gather(*self._tasks)

    # ---- serving ------------------------------------------------------------

    async def _serve(self, conn, network: str) -> None:
        try:
            async for raw in conn:
                try:
                    f = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                await self._handle(conn, network, f)
        except websockets.ConnectionClosed:
            log.info("%s: relay for %s closed the link", self.decl.id, network)
        except asyncio.CancelledError:
            raise

    async def _handle(self, conn, network: str, f: dict) -> None:
        t = f.get("t")

        if t == "REGISTERED":
            log.info("%s: claimed its line on %s", self.decl.id, network)
            self._registered.set()
            return

        if t == "REJECTED":
            raise NodeHostError(
                f"{self.decl.id}: relay refused the claim on {network}: {f.get('reason')}")

        if t == "RING":
            call = int(f["call"])
            self.sessions[call] = Session(call=call)
            await conn.send(json.dumps({"t": "ANSWER", "call": call}))
            await self._turn(conn, call, "CONNECT", None)
            return

        if t == "FRAME":
            call = int(f["call"])
            if call in self.sessions:
                await self._turn(conn, call, "INPUT", f.get("data", ""))
            return

        if t == "CLOSE":
            self.sessions.pop(int(f["call"]), None)
            return

        if t == "PING":
            await conn.send(json.dumps({"t": "PONG"}))
            return

    async def _turn(self, conn, call: int, command: str, user_input: str | None) -> None:
        """One user turn — which may take several program invocations.

        A response carrying a CALL is a continuation: the program has said what
        it can so far, named a peer, and ended. We deliver its DISPLAY (so the
        caller sees SEARCHING... while the call is in flight), fetch the answer,
        and re-invoke it with RESUME. Repeat until it stops asking.
        """
        session = self.sessions.get(call)
        if session is None:
            return

        reply: Reply | None = None
        depth = 0

        while True:
            state = self.store.load() if self.store else session.state
            try:
                resp = await self.runner.run(
                    self.decl.id, command, state, user_input, reply=reply)
            except SystemTimeout:
                await self._drop(conn, call, "NO CARRIER")
                return
            except SystemBusy:
                await self._say(conn, call, "SYSTEM BUSY - TRY AGAIN")
                return
            except SystemFault as exc:
                log.warning("%s: %s", self.decl.id, exc)
                await self._drop(conn, call, "NO CARRIER")
                return

            if self.store is not None:
                self.store.save(resp.state)
            else:
                session.state = resp.state
            if resp.display:
                await self._say(conn, call, resp.display)

            if resp.prompt:
                await conn.send(json.dumps(
                    {"t": "PROMPT", "call": call, "data": resp.prompt}))

            if resp.line == "DROP":
                await self._drop(conn, call, "NO CARRIER")
                return

            if resp.call is None:
                return

            # It wants a peer. Fetch the answer and resume it.
            reply = await execute_call(
                resp.call, self.decl, self.topology, self.relays,
                caller=self.decl.id, depth=depth,
            )
            depth += 1
            command, user_input = "RESUME", None

    async def _say(self, conn, call: int, text: str) -> None:
        # Wrapped in newlines, the way the bridge has always framed a DISPLAY:
        # without them a prompt runs straight into whatever is said next
        # ("PASSWORD:WELCOME TO DISTRICT DATANET").
        await conn.send(json.dumps({"t": "FRAME", "call": call, "data": f"\n{text}\n"}))

    async def _drop(self, conn, call: int, reason: str) -> None:
        self.sessions.pop(call, None)
        await conn.send(json.dumps({"t": "CLOSE", "call": call, "reason": reason}))
