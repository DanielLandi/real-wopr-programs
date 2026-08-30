"""The topology, as JSON, for anything that is not Python.

The loader and its rules live in Python (topology.py, topology_validate.py) and
stay there. The supervisor is TypeScript and needs the same answers, so rather
than reimplementing ten validation rules in a second language — and letting them
drift — it asks this.

    python -m app.topologycli --pack <root>

Prints {networks, nodes, problems} and exits 1 if any problem is an error, so a
caller can use the exit code as the gate and the JSON as the map.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .topology import load_topology
from .topology_validate import errors, validate


def describe(pack_root: Path) -> tuple[dict, bool]:
    topo = load_topology(pack_root)
    pack = json.loads((pack_root / "pack.json").read_text())
    program_ids = {p["id"] for p in pack["programs"]}
    program_paths = {p["id"]: p["path"] for p in pack["programs"]}
    problems = validate(topo, program_ids, program_paths, pack)

    out = {
        "networks": {
            name: {
                "name": n.name, "kind": n.kind, "addressing": n.addressing,
                "baud": n.baud, "public": n.public, "private": n.private,
            }
            for name, n in topo.networks.items()
        },
        "nodes": {
            node_id: {
                "id": d.id,
                "title": d.title,
                "networks": {
                    net: {"address": a.address, "protocol": a.protocol}
                    for net, a in d.networks.items()
                },
                "mounts": list(d.mounts),
                "peers": list(d.peers),
                "state": d.state,
                "callable_by": list(d.callable_by) if d.callable_by is not None else None,
            }
            for node_id, d in topo.nodes.items()
        },
        "problems": [
            {"level": p.level, "code": p.code, "message": p.message} for p in problems
        ],
    }
    return out, bool(errors(problems))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pack", default=".", help="pack root (default: cwd)")
    args = ap.parse_args(argv)

    described, has_errors = describe(Path(args.pack).resolve())
    json.dump(described, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 1 if has_errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
