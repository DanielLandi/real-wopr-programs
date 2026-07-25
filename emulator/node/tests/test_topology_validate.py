"""Every reason a declared topology is rejected, one test per rule."""

import json
from pathlib import Path

from app.topology import Address, Network, NodeDecl, Topology, load_topology
from app.topology_validate import errors, validate

PACK = Path(__file__).resolve().parent.parent.parent.parent
PROGRAMS = {"school", "school-db", "airline", "reference", "gtw", "tictactoe", "joshua"}


def _net(name="pstn", addressing="phone"):
    return Network(name=name, kind="dialup", addressing=addressing, baud=300, public=True)


def _node(node_id, address="(206) 555-0142", net="pstn", **kw):
    return NodeDecl(
        id=node_id, title=node_id.upper(),
        networks={net: Address(network=net, address=address, protocol="SYSTEM/1")},
        **kw,
    )


def _codes(t, programs=PROGRAMS):
    return {p.code for p in validate(t, programs)}


def test_unknown_network_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={"school": _node("school", net="norad")})
    assert "unknown-network" in _codes(t)


def test_duplicate_address_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={
        "school": _node("school"), "airline": _node("airline"),
    })
    assert "duplicate-address" in _codes(t)


def test_phone_addresses_compare_as_digits():
    """(206) 555-0142 and 206-555-0142 are the same line."""
    t = Topology(networks={"pstn": _net()}, nodes={
        "school": _node("school", "(206) 555-0142"),
        "airline": _node("airline", "206-555-0142"),
    })
    assert "duplicate-address" in _codes(t)


def test_the_same_address_on_two_different_networks_is_fine():
    t = Topology(
        networks={"pstn": _net(), "bus": _net("bus", "name")},
        nodes={
            "school": _node("school", "SHARED", net="pstn"),
            "school-db": _node("school-db", "SHARED", net="bus"),
        },
    )
    assert "duplicate-address" not in _codes(t)


def test_unknown_peer_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={"school": _node("school", peers=("ghost",))})
    assert "unknown-peer" in _codes(t)


def test_unknown_mount_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={"school": _node("school", mounts=("nope",))})
    assert "unknown-mount" in _codes(t)


def test_empty_glob_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={"school": _node("school", mounts=("nope/*",))})
    assert "empty-glob" in _codes(t)


def test_a_glob_that_matches_is_accepted():
    t = Topology(networks={"pstn": _net()}, nodes={"wopr": _node("wopr", mounts=("games/*",))})
    paths = {"gtw": "games/gtw", "tictactoe": "games/tictactoe", "joshua": "joshua"}
    problems = validate(t, PROGRAMS, paths)
    assert {"empty-glob", "unknown-mount"} & {p.code for p in problems} == set()


def test_peer_cycle_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={
        "school": _node("school", "(206) 555-0142", peers=("airline",)),
        "airline": _node("airline", "(415) 555-0113", peers=("school",)),
    })
    assert "peer-cycle" in _codes(t)


def test_callable_by_is_enforced():
    t = Topology(networks={"pstn": _net()}, nodes={
        "school": _node("school", "(206) 555-0142", peers=("school-db",)),
        "school-db": _node("school-db", "(206) 555-0199", callable_by=("airline",)),
    })
    assert "uncallable-peer" in _codes(t)


def test_callable_by_permits_the_named_caller():
    t = Topology(networks={"pstn": _net()}, nodes={
        "school": _node("school", "(206) 555-0142", peers=("school-db",)),
        "school-db": _node("school-db", "(206) 555-0199", callable_by=("school",)),
    })
    assert "uncallable-peer" not in _codes(t)


def test_peer_on_no_shared_network_is_unreachable():
    t = Topology(
        networks={"pstn": _net(), "norad": _net("norad", "hostname")},
        nodes={
            "school": _node("school", peers=("reference",)),
            "reference": _node("reference", "REFERENCE", net="norad"),
        },
    )
    assert "unreachable-peer" in _codes(t)


def test_missing_address_is_an_error():
    t = Topology(networks={"pstn": _net()}, nodes={"school": _node("school", address="")})
    assert "no-address" in _codes(t)


def test_composite_host_warns_but_does_not_fail():
    t = Topology(networks={"pstn": _net()},
                 nodes={"wopr": _node("wopr", source="pack.json")})
    problems = validate(t, PROGRAMS)
    assert "composite-host" in {p.code for p in problems}
    assert errors(problems) == []


def test_the_real_pack_topology_is_valid():
    t = load_topology(PACK)
    pack = json.loads((PACK / "pack.json").read_text())
    programs = {p["id"] for p in pack["programs"]}
    paths = {p["id"]: p["path"] for p in pack["programs"]}
    problems = validate(t, programs, paths)
    assert errors(problems) == [], [p.message for p in errors(problems)]


def test_the_real_pack_warns_only_about_wopr_waiting_for_period_source():
    t = load_topology(PACK)
    pack = json.loads((PACK / "pack.json").read_text())
    programs = {p["id"] for p in pack["programs"]}
    paths = {p["id"]: p["path"] for p in pack["programs"]}
    warnings = [p for p in validate(t, programs, paths) if p.level == "warning"]
    assert [(w.code, "wopr" in w.message) for w in warnings] == [("composite-host", True)]
