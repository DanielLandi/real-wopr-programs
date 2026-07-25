"""Topology loader — what the pack declares about the federation's shape."""

from pathlib import Path

from app.topology import load_networks, load_nodes, load_topology

PACK = Path(__file__).resolve().parent.parent.parent.parent


def test_loads_the_three_networks():
    nets = load_networks(PACK / "pack.json")
    assert set(nets) == {"pstn", "norad", "bus"}


def test_pstn_is_public_dialup_at_300_baud():
    pstn = load_networks(PACK / "pack.json")["pstn"]
    assert (pstn.kind, pstn.baud, pstn.addressing, pstn.public) == ("dialup", 300, "phone", True)


def test_bus_is_private_and_has_no_baud():
    bus = load_networks(PACK / "pack.json")["bus"]
    assert bus.private is True
    assert bus.public is False
    assert bus.baud is None


def test_school_declares_itself_on_the_phone_network():
    school = load_nodes(PACK)["school"]
    assert school.networks["pstn"].address == "(206) 555-0142"
    assert school.networks["pstn"].protocol == "SYSTEM/1"
    assert school.source == "manifest"


def test_every_dialable_system_keeps_the_number_its_manifest_already_had():
    """The node block must not shift the phone book."""
    nodes = load_nodes(PACK)
    for sid, number in [
        ("airline", "(212) 555-0177"), ("pactel", "(311) 555-0100"),
        ("protovision", "(408) 555-0163"), ("reference", "(311) 555-0101"),
        ("school", "(206) 555-0142"),
    ]:
        assert nodes[sid].networks["pstn"].address == number


def test_reference_is_also_on_the_norad_network():
    """It is WOPR's peer there — one node, two networks, like WOPR itself."""
    assert load_nodes(PACK)["reference"].networks["norad"].address == "REFERENCE"


def test_wopr_is_a_composite_host_waiting_for_period_source():
    wopr = load_nodes(PACK)["wopr"]
    assert set(wopr.networks) == {"pstn", "norad"}
    assert wopr.source == "pack.json"
    assert "games/*" in wopr.mounts


def test_games_are_not_nodes():
    nodes = load_nodes(PACK)
    assert "gtw" not in nodes
    assert "tictactoe" not in nodes


def test_topology_pairs_networks_with_nodes():
    t = load_topology(PACK)
    assert set(t.networks) == {"pstn", "norad", "bus"}
    assert "school" in t.nodes
