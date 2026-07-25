"""Peripheral-system registry from manifests (docs/systems.md). Each
systems/<id>/manifest.json describes one dial-in system."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class System:
    id: str
    title: str
    language: str
    binary: str
    number: str
    timeout_s: float | None = None


def load_systems(systems_dir: Path) -> dict[str, System]:
    out: dict[str, System] = {}
    if not systems_dir.is_dir():
        return out
    for manifest in sorted(systems_dir.glob("*/harness/manifest.json")):
        data = json.loads(manifest.read_text())
        sid = data["id"]
        timeout = data.get("timeout_s")
        if timeout is not None:
            timeout = min(float(timeout), 10.0)  # hard cap, matching games.py / deployment.md D2
        out[sid] = System(
            id=sid,
            title=data["title"],
            language=data["language"],
            binary=data["binary"],
            number=data["number"],
            timeout_s=timeout,
        )
    return out
