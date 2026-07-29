"""Interpretations: nested slots, selection, pinning (docs/games.md §8, real-wopr#144).

A slot with a second reconstruction converts from games/<id>/ to
games/<id>/<interpretation>/; the host maps (slot, interpretation) -> binary
and a session pins its interpretation at start. Flat slots are untouched.
"""

import json
from pathlib import Path

import pytest

from app.games import (Interpretation, interpretation_dir,
                       list_interpretations_text, load_catalog, match_slot,
                       resolve_selector)

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


# -- selection (Task 2) -------------------------------------------------------

def test_match_slot_by_id_and_exact_title():
    catalog = load_catalog(REPO / "games")
    assert match_slot(catalog, "TICTACTOE").id == "tictactoe"
    assert match_slot(catalog, "TIC-TAC-TOE").id == "tictactoe"
    assert match_slot(catalog, "NOPE") is None


def test_resolve_selector_number_name_author(nested_games_dir):
    game = load_catalog(nested_games_dir)["chess"]
    assert resolve_selector(game, "1") == "core"
    assert resolve_selector(game, "2") == "minimal"
    assert resolve_selector(game, "MINIMAL") == "minimal"
    assert resolve_selector(game, "DANIEL") == "minimal"
    assert resolve_selector(game, "3") is None
    assert resolve_selector(game, "BOGUS") is None


def test_resolve_selector_on_flat_slot_accepts_only_core():
    game = load_catalog(REPO / "games")["tictactoe"]
    assert resolve_selector(game, "1") == "core"
    assert resolve_selector(game, "CORE") == "core"
    assert resolve_selector(game, "2") is None


def test_list_interpretations_output(nested_games_dir):
    game = load_catalog(nested_games_dir)["chess"]
    assert list_interpretations_text(game) == "CHESS\n1. CORE\n2. MINIMAL - DANIEL"


def test_list_interpretations_flat_slot():
    game = load_catalog(REPO / "games")["tictactoe"]
    assert list_interpretations_text(game) == "TIC-TAC-TOE\n1. CORE"


def test_interpretation_dir_flat_nested_and_vanished(nested_games_dir):
    flat = load_catalog(REPO / "games")["tictactoe"]
    nested = load_catalog(nested_games_dir)["chess"]
    assert interpretation_dir(flat, "core") is None
    assert interpretation_dir(nested, "minimal") == "minimal"
    with pytest.raises(KeyError):
        interpretation_dir(nested, "gone")


# -- runner dispatch (Task 3) -------------------------------------------------

import asyncio

from app.runner import CoreError, CoreRunner, RunnerConfig


def test_binary_for_nested_and_flat(nested_games_dir):
    r = CoreRunner(RunnerConfig(bin_dir=nested_games_dir))
    assert r.binary_for("chess", "minimal") == (
        nested_games_dir / "chess" / "minimal" / "harness" / "bin" / "chess")
    assert r.binary_for("chess") == (
        nested_games_dir / "chess" / "harness" / "bin" / "chess")


def test_binary_for_rejects_unsafe_interp_dir(nested_games_dir):
    r = CoreRunner(RunnerConfig(bin_dir=nested_games_dir))
    with pytest.raises(CoreError):
        r.binary_for("chess", "../joshua")


def test_run_dispatches_to_the_pinned_interpretation(nested_games_dir):
    r = CoreRunner(RunnerConfig(bin_dir=nested_games_dir))

    async def flow():
        core = await r.run("chess", "NEW", None, None, interp_dir="core")
        alt = await r.run("chess", "NEW", None, None, interp_dir="minimal")
        assert core.state == "CORE-STUB"
        assert alt.state == "ALT-STUB"

    asyncio.run(flow())


# -- persisted pin (Task 4) ---------------------------------------------------

from app.store import GameState, MemoryStore


def test_game_row_pin_survives_store_round_trip():
    store = MemoryStore()

    async def flow():
        gs = GameState(session_id="s1", game_id="chess", state="ALT-STUB",
                       status="PLAYING", turn=1, interpretation="minimal")
        await store.upsert_game(gs)
        back = await store.get_active_game("s1")
        assert back.interpretation == "minimal"

    asyncio.run(flow())


def test_game_row_pin_defaults_to_core():
    gs = GameState(session_id="s", game_id="g", state="", status="PLAYING")
    assert gs.interpretation == "core"
