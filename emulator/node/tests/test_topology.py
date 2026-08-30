"""Topology loader — what the pack declares about the federation's shape."""

from pathlib import Path

from app.topology import load_networks, load_nodes, load_topology

PACK = Path(__file__).resolve().parent.parent.parent.parent


def test_loads_the_three_networks():
    nets = load_networks(PACK / "pack.json")
    assert set(nets) == {"pstn", "norad", "bus"}


def test_pstn_is_public_dialup_at_600_baud():
    pstn = load_networks(PACK / "pack.json")["pstn"]
    assert (pstn.kind, pstn.baud, pstn.addressing, pstn.public) == ("dialup", 600, "phone", True)


def test_bus_is_private_and_has_no_baud():
    bus = load_networks(PACK / "pack.json")["bus"]
    assert bus.private is True
    assert bus.public is False
    assert bus.baud is None


def test_school_no_longer_declares_itself_on_the_phone_network():
    """Task 7: school's phone line moved to school-mon (next task); school is
    now bus-only, reached by EXEC rather than a direct RING."""
    school = load_nodes(PACK)["school"]
    assert "pstn" not in school.networks
    assert school.networks["bus"].address == "SCHOOL"
    assert school.networks["bus"].protocol == "SYSTEM/1"


def test_every_dialable_system_keeps_the_number_its_manifest_already_had():
    """The node block must not shift the phone book — except school, which
    Task 7 removed from it on purpose (see the test above)."""
    nodes = load_nodes(PACK)
    for sid, number in [
        ("airline", "(212) 555-0177"), ("pactel", "(311) 555-0100"),
        ("protovision", "(408) 555-0163"), ("reference", "(311) 555-0101"),
        ("school-mon", "(206) 555-0142"), ("umb", "(408) 555-0164"),
    ]:
        assert nodes[sid].networks["pstn"].address == number
    assert "pstn" not in nodes["school"].networks


def test_reference_is_also_on_the_norad_network():
    """It is WOPR's peer there — one node, two networks, like WOPR itself."""
    assert load_nodes(PACK)["reference"].networks["norad"].address == "REFERENCE"


def test_wopr_declares_itself_in_its_own_manifest():
    """Phase 4 of the executive design (real-wopr#198): the waiting room
    empties, and node declarations are uniform. WOPR is the dual-homed
    machine the film rests on, and it mounts the console it hands a cleared
    operator to."""
    wopr = load_nodes(PACK)["wopr"]
    assert set(wopr.networks) == {"pstn", "norad"}
    assert wopr.networks["pstn"].address == "(311) 486-0623"
    assert wopr.networks["norad"].address == "WOPR"
    assert wopr.mounts == ("games/*", "joshua", "norad")
    assert wopr.peers == ("reference",)


def test_pack_json_declares_no_nodes():
    import json
    pack = json.loads((PACK / "pack.json").read_text())
    assert "nodes" not in pack


def test_a_pack_json_nodes_key_declares_nothing(tmp_path):
    """The waiting room is gone: a node written into pack.json is not loaded.
    Rejecting the key is the validator's job (test_topology_validate)."""
    import json
    (tmp_path / "pack.json").write_text(json.dumps({
        "programs": [],
        "networks": {"pstn": {"kind": "dialup", "addressing": "phone"}},
        "nodes": {"ghost": {"networks": {"pstn": {"address": "(206) 555-0000"}}}},
    }))
    assert load_nodes(tmp_path) == {}


def test_games_are_not_nodes():
    nodes = load_nodes(PACK)
    assert "gtw" not in nodes
    assert "tictactoe" not in nodes


def test_topology_pairs_networks_with_nodes():
    t = load_topology(PACK)
    assert set(t.networks) == {"pstn", "norad", "bus"}
    assert "school" in t.nodes
