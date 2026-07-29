"""Interpretations: nested slots, selection, pinning (docs/games.md §8, real-wopr#144).

A slot with a second reconstruction converts from games/<id>/ to
games/<id>/<interpretation>/; the host maps (slot, interpretation) -> binary
and a session pins its interpretation at start. Flat slots are untouched.
"""

import json
from pathlib import Path

import pytest

from app.games import Interpretation, load_catalog

REPO = Path(__file__).resolve().parent.parent.parent.parent

CORE_FRAME = ("WOPR/1 chess OK\nSTATE 1\nCORE-STUB\nDISPLAY 1\n"
              "CORE STUB BOARD\nSTATUS PLAYING\nEND\n")
ALT_FRAME = ("WOPR/1 chess OK\nSTATE 1\nALT-STUB\nDISPLAY 1\n"
             "ALT STUB BOARD\nSTATUS PLAYING\nEND\n")


def _manifest(interpretation: str, author: str) -> dict:
    return {"id": "chess", "title": "Chess", "status": "implemented",
            "binary": "chess", "players": 2, "summary": "stub",
            "input_syntax": "stub", "interpretation": interpretation,
            "author": author}


def _write_interp(slot: Path, name: str, author: str, frame: str) -> None:
    """A fake interpretation whose 'binary' swallows stdin and answers a
    canned frame — the STATE line names the interpretation, so tests can
    assert which binary actually ran."""
    h = slot / name / "harness"
    (h / "bin").mkdir(parents=True)
    (h / "manifest.json").write_text(json.dumps(_manifest(name, author)))
    stub = h / "bin" / "chess"
    stub.write_text("#!/bin/sh\ncat > /dev/null\ncat <<'EOF'\n" + frame + "EOF\n")
    stub.chmod(0o755)


@pytest.fixture
def nested_games_dir(tmp_path: Path) -> Path:
    slot = tmp_path / "games" / "chess"
    _write_interp(slot, "core", "core", CORE_FRAME)
    _write_interp(slot, "minimal", "daniel", ALT_FRAME)
    return tmp_path / "games"


# -- discovery (Task 1) -------------------------------------------------------

def test_nested_slot_is_discovered_from_its_core_manifest(nested_games_dir):
    catalog = load_catalog(nested_games_dir)
    game = catalog["chess"]
    assert game.status == "implemented"
    assert game.title == "CHESS"
    assert game.interpretations == (
        Interpretation(name="core", author="core"),
        Interpretation(name="minimal", author="daniel"),
    )


def test_flat_slots_have_no_interpretations():
    catalog = load_catalog(REPO / "games")
    assert catalog["tictactoe"].interpretations == ()


def test_nested_slot_without_core_is_a_hard_error(nested_games_dir):
    import shutil
    shutil.rmtree(nested_games_dir / "chess" / "core")
    with pytest.raises(ValueError, match="core"):
        load_catalog(nested_games_dir)


def test_sub_manifest_with_wrong_id_is_a_hard_error(nested_games_dir):
    man = nested_games_dir / "chess" / "minimal" / "harness" / "manifest.json"
    bad = json.loads(man.read_text())
    bad["id"] = "checkers"
    man.write_text(json.dumps(bad))
    with pytest.raises(ValueError, match="minimal"):
        load_catalog(nested_games_dir)
