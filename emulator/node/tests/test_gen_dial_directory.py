"""The generator that makes the manifests the authority (real-wopr#166)."""
import importlib.util
import json
from pathlib import Path

PACK = Path(__file__).resolve().parents[3]

spec = importlib.util.spec_from_file_location("gdd", PACK / "tools" / "gen-dial-directory.py")
gdd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gdd)


def test_collect_dialable_is_the_registry_not_the_directory_listing():
    ids = [d["id"] for d in gdd.collect_dialable(PACK)]
    assert ids == ["airline", "pactel", "protovision", "reference", "school-mon"]
    assert "school" not in ids and "school-db" not in ids


def test_collect_dialable_carries_the_number_from_the_manifest():
    by_id = {d["id"]: d for d in gdd.collect_dialable(PACK)}
    assert by_id["school-mon"]["number"] == "(206) 555-0142"
    assert by_id["airline"]["title"] == "PAN AM / PANAMAC RESERVATIONS"


def test_collect_programs_derives_kind_protocol_and_path():
    by_id = {p["id"]: p for p in gdd.collect_programs(PACK)}
    assert by_id["poker"]["kind"] == "game"
    assert by_id["poker"]["protocol"] == "WOPR/1"
    assert by_id["poker"]["path"] == "games/poker"
    assert by_id["airline"]["kind"] == "system"
    assert by_id["airline"]["protocol"] == "SYSTEM/1"
    assert by_id["joshua"]["kind"] == "joshua"


def test_collect_programs_emits_tictactoe_once_from_its_slot():
    """tictactoe has no manifest of its own — it is a nested interpretations
    slot (games/tictactoe/{core,heuristic}). The index names the slot, not the
    interpretations."""
    ids = [p["id"] for p in gdd.collect_programs(PACK)]
    assert ids.count("tictactoe") == 1
    assert "core" not in ids and "heuristic" not in ids


def test_generated_output_matches_what_is_committed():
    """The regenerate-and-diff guarantee, asserted directly."""
    assert gdd.main(["--check"]) == 0, "committed artifacts are stale — run tools/gen-dial-directory.py"
