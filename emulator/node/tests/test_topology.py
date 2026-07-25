"""Topology loader — what the pack declares about the federation's shape."""

from pathlib import Path

from app.topology import load_networks

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
