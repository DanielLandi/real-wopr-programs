"""The federation's shape, as declared by the pack.

Networks are global and few, so they live in pack.json. Node declarations live
with the program that is the node (its harness/manifest.json) — every one of
them, now that the executive is a program (`wopr/harness/manifest.json`). A
pack.json `nodes` section is still read as a waiting room for a node that has
no period source yet; this pack's is empty, and the validator warns about any
entry a pack puts there.

This module only loads and shapes. Every rejection rule lives in
topology_validate.py, so the rules can be read as a list.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

ADDRESSING = {"phone", "hostname", "name"}


@dataclass(frozen=True)
class Network:
    name: str
    kind: str            # dialup | leased | local
    addressing: str      # phone | hostname | name
    baud: int | None = None
    public: bool = False
    private: bool = False


def load_networks(pack_json: Path) -> dict[str, Network]:
    data = json.loads(pack_json.read_text())
    out: dict[str, Network] = {}
    for name, n in data.get("networks", {}).items():
        out[name] = Network(
            name=name,
            kind=n["kind"],
            addressing=n["addressing"],
            baud=n.get("baud"),
            public=bool(n.get("public", False)),
            private=bool(n.get("private", False)),
        )
    return out


@dataclass(frozen=True)
class Address:
    network: str
    address: str
    protocol: str


@dataclass(frozen=True)
class NodeDecl:
    id: str
    title: str
    networks: dict[str, Address]
    mounts: tuple[str, ...] = ()
    peers: tuple[str, ...] = ()
    state: str = "ephemeral"                      # ephemeral | persistent
    callable_by: tuple[str, ...] | None = None    # None => anyone sharing a network
    source: str = "manifest"                      # manifest | pack.json


@dataclass(frozen=True)
class Topology:
    networks: dict[str, Network]
    nodes: dict[str, NodeDecl]


def _node_from(node_id: str, title: str, block: dict, source: str,
               default_protocol: str) -> NodeDecl:
    addrs: dict[str, Address] = {}
    for net, spec in block.get("networks", {}).items():
        addrs[net] = Address(
            network=net,
            address=spec.get("address", ""),
            protocol=spec.get("protocol", default_protocol),
        )
    callable_by = block.get("callable_by")
    return NodeDecl(
        id=node_id,
        title=title,
        networks=addrs,
        mounts=tuple(block.get("mounts", ())),
        peers=tuple(block.get("peers", ())),
        state=block.get("state", "ephemeral"),
        callable_by=tuple(callable_by) if callable_by is not None else None,
        source=source,
    )


def _program_manifests(pack_root: Path, data: dict) -> list[Path]:
    """Every program manifest, at the depths the pack contract uses:
    `<cat>/harness` (joshua, wopr, norad), `<cat>/<id>/harness` (games,
    systems), `<cat>/<id>/<interpretation>/harness` (tictactoe). Bounded to the
    categories pack.json declares, so `emulator/` can never be swept in."""
    cats = sorted({p["path"].split("/")[0] for p in data.get("programs", [])})
    return [m for c in cats for depth in ("harness", "*/harness", "*/*/harness")
            for m in sorted(pack_root.glob(f"{c}/{depth}/manifest.json"))]


def load_nodes(pack_root: Path) -> dict[str, NodeDecl]:
    """Node declarations from program manifests, plus the pack.json waiting room.

    A program folder without a `node` block is not a node — it is somebody's
    mount. Games stay games: GTW is not something you dial, it is something
    WOPR runs for you.
    """
    out: dict[str, NodeDecl] = {}
    data = json.loads((pack_root / "pack.json").read_text())

    for manifest in _program_manifests(pack_root, data):
        m = json.loads(manifest.read_text())
        block = m.get("node")
        if block is None:
            continue
        out[m["id"]] = _node_from(
            m["id"], m.get("title", m["id"]), block, "manifest",
            m.get("protocol", "SYSTEM/1"),
        )

    for node_id, block in data.get("nodes", {}).items():
        out[node_id] = _node_from(
            node_id, block.get("title", node_id), block, "pack.json", "SYSTEM/1",
        )
    return out


def load_topology(pack_root: Path) -> Topology:
    return Topology(
        networks=load_networks(pack_root / "pack.json"),
        nodes=load_nodes(pack_root),
    )
