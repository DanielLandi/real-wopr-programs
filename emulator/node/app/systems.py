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
        if "number" not in data:
            # This registry is the *dial-in* directory: what answers a phone
            # line. A system with no number is not dialable — a store on the
            # local bus, reached only by the node that owns it. It is still a
            # program and still built and golden-tested; it just never appears
            # in the phone book.
            continue
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


@dataclass(frozen=True)
class Program:
    """Any program in the pack, dialable or not.

    load_systems above is the phone book and skips anything with no number.
    The session stack needs the other kind too: a records program reached only
    by EXEC, a store reached only by CALL. Same manifests, different question.
    """
    id: str
    binary: str
    timeout_s: float | None = None
    execs: tuple[str, ...] = ()


def load_programs(systems_dir: Path) -> dict[str, Program]:
    out: dict[str, Program] = {}
    if not systems_dir.is_dir():
        return out
    for manifest in sorted(systems_dir.glob("*/harness/manifest.json")):
        data = json.loads(manifest.read_text())
        program_id = data["id"]
        timeout = data.get("timeout_s")
        if timeout is not None:
            timeout = min(float(timeout), 10.0)   # same cap as load_systems
        execs_raw = data.get("node", {}).get("execs", ())
        # Every non-list, not merely the truthy ones. `"execs": null` used to
        # short-circuit past this guard and die inside tuple() with a TypeError
        # naming neither the manifest nor the field.
        if not isinstance(execs_raw, (list, tuple)):
            raise ValueError(
                f"{program_id} manifest declares execs, but it is not a list: {execs_raw!r}"
            )
        out[program_id] = Program(
            id=program_id,
            binary=data["binary"],
            timeout_s=timeout,
            execs=tuple(execs_raw),
        )
    return out


def validate_execs(programs: dict[str, Program]) -> None:
    """Every EXEC target must be a program in this pack (docs/systems.md §2.6).

    Caught at load, not at runtime: a caller on a phone line should never be
    the one to discover a manifest typo.
    """
    for program in programs.values():
        for target in program.execs:
            if target not in programs:
                raise ValueError(
                    f"{program.id} declares EXEC target {target!r}, "
                    "which is not a program in this pack")
