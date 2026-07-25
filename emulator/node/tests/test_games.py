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


def test_no_game_declares_a_move_pattern_any_more():
    # Attachment removed the need to classify a typed line, so the regex that
    # did it is gone from the pack — not re-notated, removed.
    import json
    for game_id in ("gtw", "tictactoe", "checkers", "hearts", "poker",
                    "blackjack", "gin-rummy", "falkens-maze"):
        manifest = json.loads(
            (GAMES_DIR / game_id / "harness" / "manifest.json").read_text())
        assert "move_pattern" not in manifest, game_id
