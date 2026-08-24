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
    assert ids == ["airline", "pactel", "protovision", "reference", "school-mon", "umb"]
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


def test_main_rejects_an_unrecognised_argument(capsys):
    """A mistyped flag (`--chek`, `--dry-run`, `-check`) must not fall through
    to write mode. Before this test, `check = "--check" in argv` treated any
    argv it did not recognise as "not --check" and quietly rewrote the
    committed files — in CI that would go green while guarding nothing."""
    pack_json = PACK / "pack.json"
    ts_file = PACK / gdd.TS_PATH
    pack_before = pack_json.read_text()
    ts_before = ts_file.read_text()

    rc = gdd.main(["--chek"])

    assert rc != 0
    assert "--chek" in capsys.readouterr().err
    assert pack_json.read_text() == pack_before, "must not write pack.json on a bad argument"
    assert ts_file.read_text() == ts_before, "must not write the generated ts file on a bad argument"
