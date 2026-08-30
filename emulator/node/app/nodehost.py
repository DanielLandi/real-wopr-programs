"""One node, one process.

The node host is the harness side of a single `node` declaration. It dials its
relays outbound, claims the lines the pack says it answers, and serves each call
by driving its program subprocess-per-turn — the same SystemRunner the bridge
uses, so a program behaves identically whether it is reached through a node or
through the monolith.

It refuses to start on a topology with validation errors. A mis-declared
federation should fail where it is declared, not halfway through a call.

A turn is session_turn.run_session_turn — the same one the monolith drives, so
EXEC/RETURN (docs/systems.md §2.6) behaves identically here. What a node does
differently is supply its own `run_program`: its peers are other machines, so a
CALL is dialled over a relay rather than answered in-process.

Scope note: a node whose id is itself a program (school, airline, school-db …)
serves that program directly, which is the common case and the whole of the
school/school-db split. A *composite* host — one that mounts others, like
WOPR — needs the router: the bridge (main.py) gathers the executive's facts and
executes its calls, and that is where WOPR is served. `wopr up` skips it here
rather than faking it.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import websockets

from .execstack import Frame, decode as decode_stack, encode as encode_stack
from .peercall import execute_call
from .session_turn import ProgramTurn, run_session_turn
from .storestate import StoreState
from .systemrunner import (
    SystemBusy, SystemFault, SystemRunner, SystemRunnerConfig, SystemTimeout,
)
from .systemwire import SystemResponse
from .systems import System, load_programs, validate_execs
from .topology import NodeDecl, Topology, load_topology
from .topology_validate import errors, validate

log = logging.getLogger("wopr.nodehost")


class NodeHostError(Exception):
    """The node cannot serve what it was asked to serve."""


@dataclass
class Session:
    """One live call: the program stack it has built up so far, encoded.

    This used to be one program's opaque STATE. With EXEC/RETURN
    (docs/systems.md §2.6) a call can be several programs deep, so the slot
    holds what execstack encodes instead — the same slot, a richer blob, still
    entirely the host's business.
    """
    call: int
    stack: str | None = None


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

        self.runtime_dir = Path(runtime_dir or (self.pack_root / ".wopr"))

        # A store's STATE belongs to its host, not to whoever called it.
        # Ephemeral nodes keep state per call, in the Session.
        self.store = (
            StoreState(self.runtime_dir, decl.id)
            if decl.state == "persistent" else None
        )

        systems_dir = self.pack_root / "systems"
        # Every program in the pack, not only this node's own: an EXEC pushes a
        # program this host then has to run itself, and it needs that program's
        # binary, timeout and exec allow-list to do it.
        self.programs = load_programs(systems_dir)
        self.runner = system_runner or SystemRunner(
            SystemRunnerConfig(systems_dir=systems_dir),
            {p.id: System(id=p.id, title="", language="", binary=p.binary,
                          number="", timeout_s=p.timeout_s)
             for p in self.programs.values()}
            # A node declared in pack.json's waiting room has no manifest of its
            # own, so it is not in `programs`; keep it resolvable by id.
            or {decl.id: System(id=decl.id, title=decl.title, language="",
                                binary=decl.id, number="", timeout_s=None)},
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

        # Same discipline one level down: an EXEC target no manifest declares
        # is a mis-declared pack, and a caller on a phone line should never be
        # the one to discover it (docs/systems.md §2.6).
        try:
            validate_execs(load_programs(pack_root / "systems"))
        except ValueError as exc:
            raise NodeHostError(f"topology has errors, refusing to start:\n  {exc}") from exc

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

    def _timeout_for(self, program: str) -> float | None:
        """Each program on the stack keeps its own manifest timeout, including
        one an EXEC pushed mid-turn."""
        p = self.programs.get(program)
        return p.timeout_s if p is not None else None

    def _execs_for(self, program: str) -> tuple[str, ...]:
        """What a program may EXEC, straight from its manifest."""
        p = self.programs.get(program)
        return p.execs if p is not None else ()

    def _program_turn(self, conn, call: int) -> ProgramTurn:
        """How one program takes its turn *on a node* — CALLs dialled out.

        The monolith answers a peer CALL in-process, because it mounts every
        program. A node cannot: `school-db` is another machine, and the call
        has to leave the box. That is also what keeps the relay's `callable_by`
        the enforcement point rather than a comment.

        A response carrying a CALL is a continuation: the program has said what
        it can so far, named a peer, and ended. Its DISPLAY goes out right away
        — the caller should see SEARCHING... while the call is in flight, not
        after it lands — and then the program is re-invoked with RESUME. The
        final response's DISPLAY is left for the turn to deliver.
        """
        async def run_one(program: str, command: str, state: str | None,
                          user_input: str | None,
                          timeout_s: float | None) -> SystemResponse:
            depth = 0
            reply = None
            while True:
                resp = await self.runner.run(program, command, state, user_input,
                                             timeout_s=timeout_s, reply=reply)
                if resp.call is None:
                    return resp
                if resp.display:
                    await self._say(conn, call, resp.display)
                # Reach belongs to the program that is running, not to the node
                # it happens to be running on: an exec'd program keeps its own
                # manifest's peers and its own name on the wire, so school-db's
                # callable_by still reads `school` when `school` is running
                # under the monitor's roof. A program with no node declaration
                # of its own borrows this node's, which is the pre-EXEC case.
                decl = self.topology.nodes.get(program, self.decl)
                reply = await execute_call(
                    resp.call, decl, self.topology, self.relays,
                    caller=program, depth=depth,
                )
                depth += 1
                command, user_input, state = "RESUME", None, resp.state

        return run_one

    async def _turn(self, conn, call: int, command: str, user_input: str | None) -> None:
        """One user turn — which may take several program invocations, and
        since §2.6 may cross from one program to another and back."""
        session = self.sessions.get(call)
        if session is None:
            return

        frames = decode_stack(session.stack, self.decl.id)
        if self.store is not None:
            # A store's STATE outlives the call, so the root frame's state
            # comes off disk rather than out of the session. Only the root: a
            # store declares no `execs`, so its stack is one frame deep and
            # this is the whole of it.
            frames[0] = Frame(frames[0].program, self.store.load())

        try:
            result = await run_session_turn(
                self.runner, frames, command, user_input,
                runtime_dir=self.runtime_dir,
                timeout_for=self._timeout_for,
                execs_for=self._execs_for,
                run_program=self._program_turn(conn, call),
            )
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
        except ValueError as exc:
            # An EXEC target no manifest declared. for_node refuses to start on
            # that, so reaching it here means a hand-built host or a pack that
            # changed underneath one: end the call rather than let the
            # exception climb out and take the node's relay link with it.
            log.warning("%s: %s", self.decl.id, exc)
            await self._drop(conn, call, "NO CARRIER")
            return

        session.stack = encode_stack(result.frames)
        if self.store is not None and result.frames and result.frames[0].state is not None:
            self.store.save(result.frames[0].state)

        if result.display:
            await self._say(conn, call, result.display)

        if result.prompt:
            await conn.send(json.dumps(
                {"t": "PROMPT", "call": call, "data": result.prompt}))

        if result.line == "DROP":
            await self._drop(conn, call, "NO CARRIER")

    async def _say(self, conn, call: int, text: str) -> None:
        # Wrapped in newlines, the way the bridge has always framed a DISPLAY:
        # without them a prompt runs straight into whatever is said next
        # ("PASSWORD:WELCOME TO DISTRICT DATANET").
        await conn.send(json.dumps({"t": "FRAME", "call": call, "data": f"\n{text}\n"}))

    async def _drop(self, conn, call: int, reason: str) -> None:
        self.sessions.pop(call, None)
        await conn.send(json.dumps({"t": "CLOSE", "call": call, "reason": reason}))
