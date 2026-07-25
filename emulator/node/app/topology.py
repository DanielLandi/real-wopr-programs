"""The federation's shape, as declared by the pack.

Networks are global and few, so they live in pack.json. Node declarations live
with the program that is the node (its harness/manifest.json), except for
composite hosts that have no period source yet — those wait in pack.json's
`nodes` section until someone writes them.

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
