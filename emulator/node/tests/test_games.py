"""Catalog loading from manifests (docs/games.md §3-4)."""

from pathlib import Path

from app.games import load_catalog

REPO = Path(__file__).resolve().parent.parent.parent.parent
GAMES_DIR = REPO / "games"


def test_catalog_carries_each_game_abbreviation():
    catalog = load_catalog(GAMES_DIR)
    assert catalog["tictactoe"].abbrev == "TTT"
    assert catalog["gtw"].abbrev == "GTW"
    assert catalog["falkens-maze"].abbrev == "MAZE"


def test_a_placeholder_game_has_no_abbreviation():
    catalog = load_catalog(GAMES_DIR)
    assert catalog["chess"].abbrev == ""
