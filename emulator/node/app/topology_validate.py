"""Every reason a declared topology is rejected, as a readable list.

Kept apart from topology.py so the rules can be read and tested one at a time.
The supervisor refuses to start when errors() is non-empty; warnings are printed
and do not block — the composite-host warning exists to keep pack.json's `nodes`
waiting room visible rather than comfortable.
"""

from __future__ import annotations

import fnmatch
from dataclasses import dataclass

from .topology import Network, NodeDecl, Topology


@dataclass(frozen=True)
class Problem:
    level: str      # error | warning
    code: str
    message: str


def errors(problems: list[Problem]) -> list[Problem]:
    return [p for p in problems if p.level == "error"]


def _normalize(address: str, net: Network | None) -> str:
    """Phone addresses route on digits, so (206) 555-0142 and 206-555-0142 are
    the same line. Other addressing schemes compare case-insensitively."""
    if net is not None and net.addressing == "phone":
        return "".join(c for c in address if c.isdigit())
    return address.strip().upper()


def _expand_mounts(node: NodeDecl, program_ids: set[str],
                   program_paths: dict[str, str]) -> tuple[set[str], list[Problem]]:
    resolved: set[str] = set()
    problems: list[Problem] = []
    for pattern in node.mounts:
        if "*" in pattern:
            hits = {pid for pid, path in program_paths.items()
                    if fnmatch.fnmatch(path, pattern)}
            if not hits:
                problems.append(Problem("error", "empty-glob",
                    f"{node.id}: mount glob {pattern!r} matches no program"))
            resolved |= hits
        elif pattern in program_ids:
            resolved.add(pattern)
        else:
            problems.append(Problem("error", "unknown-mount",
                f"{node.id}: mounts {pattern!r}, which is not a program"))
    return resolved, problems


def _find_cycle(nodes: dict[str, NodeDecl]) -> list[str] | None:
    WHITE, GREY, BLACK = 0, 1, 2
    colour = {n: WHITE for n in nodes}

    def walk(n: str, trail: list[str]) -> list[str] | None:
        colour[n] = GREY
        for peer in nodes[n].peers:
            if peer not in nodes:
                continue
            if colour[peer] == GREY:
                return trail + [n, peer]
            if colour[peer] == WHITE:
                found = walk(peer, trail + [n])
                if found:
                    return found
        colour[n] = BLACK
        return None

    for n in nodes:
        if colour[n] == WHITE:
            found = walk(n, [])
            if found:
                return found
    return None


def validate(t: Topology, program_ids: set[str],
             program_paths: dict[str, str] | None = None) -> list[Problem]:
    problems: list[Problem] = []
    program_paths = program_paths or {pid: pid for pid in program_ids}

    seen: dict[tuple[str, str], str] = {}
    for node in t.nodes.values():
        if node.source == "pack.json":
            problems.append(Problem("warning", "composite-host",
                f"{node.id}: declared in pack.json — it has no period source yet"))

        for net_name, addr in node.networks.items():
            net = t.networks.get(net_name)
            if net is None:
                problems.append(Problem("error", "unknown-network",
                    f"{node.id}: claims network {net_name!r}, which pack.json does not declare"))
                continue
            if not addr.address.strip():
                problems.append(Problem("error", "no-address",
                    f"{node.id}: on {net_name} with no address"))
                continue
            key = (net_name, _normalize(addr.address, net))
            if key in seen:
                problems.append(Problem("error", "duplicate-address",
                    f"{node.id} and {seen[key]} both answer {addr.address!r} on {net_name}"))
            else:
                seen[key] = node.id

        _, mount_problems = _expand_mounts(node, program_ids, program_paths)
        problems += mount_problems

        for peer_id in node.peers:
            peer = t.nodes.get(peer_id)
            if peer is None:
                problems.append(Problem("error", "unknown-peer",
                    f"{node.id}: peers {peer_id!r}, which is not a declared node"))
                continue
            if peer.callable_by is not None and node.id not in peer.callable_by:
                problems.append(Problem("error", "uncallable-peer",
                    f"{node.id}: peers {peer_id!r}, whose callable_by excludes it"))
            if not (set(node.networks) & set(peer.networks)):
                problems.append(Problem("error", "unreachable-peer",
                    f"{node.id}: peers {peer_id!r} but shares no network with it"))

    cycle = _find_cycle(t.nodes)
    if cycle:
        problems.append(Problem("error", "peer-cycle",
            "peer graph has a cycle: " + " -> ".join(cycle)))

    return problems
