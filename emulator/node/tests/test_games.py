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
    for game_id in ("gtw", "checkers", "hearts", "poker",
                    "blackjack", "gin-rummy", "falkens-maze"):
        manifest = json.loads(
            (GAMES_DIR / game_id / "harness" / "manifest.json").read_text())
        assert "move_pattern" not in manifest, game_id
    # tictactoe is a nested slot (§8): every interpretation's manifest obeys.
    for manifest_path in sorted((GAMES_DIR / "tictactoe").glob("*/harness/manifest.json")):
        assert "move_pattern" not in json.loads(manifest_path.read_text()), str(manifest_path)
