import json
from pathlib import Path

import pytest

from app.systems import Program, load_programs, load_systems, validate_execs

PACK = Path(__file__).resolve().parents[3]


def _write_pack(tmp_path, *manifests):
    for m in manifests:
        d = tmp_path / m["id"] / "harness"
        d.mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps(m))
    return tmp_path


def test_load_programs_includes_numberless_systems(tmp_path):
    """The regression this whole task exists for: a program with no phone
    number is still a program. load_systems drops it; load_programs must not."""
    pack = _write_pack(
        tmp_path,
        {"id": "school-mon", "title": "M", "language": "basic",
         "binary": "school-mon", "number": "(206) 555-0142",
         "node": {"execs": ["school"]}},
        {"id": "school", "title": "R", "language": "basic", "binary": "school"},
    )
    programs = load_programs(pack)
    assert set(programs) == {"school-mon", "school"}
    assert "school" not in load_systems(pack)      # still out of the phone book
    assert programs["school-mon"].execs == ("school",)
    assert programs["school"].execs == ()


def test_load_programs_caps_the_timeout(tmp_path):
    pack = _write_pack(tmp_path, {"id": "slow", "title": "S", "language": "basic",
                                  "binary": "slow", "timeout_s": 99})
    assert load_programs(pack)["slow"].timeout_s == 10.0


def test_validate_execs_accepts_a_declared_target(tmp_path):
    pack = _write_pack(
        tmp_path,
        {"id": "school-mon", "title": "M", "language": "basic",
         "binary": "school-mon", "node": {"execs": ["school"]}},
        {"id": "school", "title": "R", "language": "basic", "binary": "school"},
    )
    validate_execs(load_programs(pack))   # must not raise


def test_validate_execs_rejects_a_missing_target(tmp_path):
    pack = _write_pack(tmp_path, {"id": "school-mon", "title": "M",
                                  "language": "basic", "binary": "school-mon",
                                  "node": {"execs": ["payroll"]}})
    with pytest.raises(ValueError, match="school-mon declares EXEC target 'payroll'"):
        validate_execs(load_programs(pack))


def test_load_programs_rejects_execs_as_string(tmp_path):
    """Manifest typo: execs is a bare string instead of a list.
    Must reject this at load time with a message pointing at the manifest,
    not at phantom one-letter programs."""
    pack = _write_pack(tmp_path, {"id": "school-mon", "title": "M",
                                  "language": "basic", "binary": "school-mon",
                                  "node": {"execs": "school"}})
    with pytest.raises(ValueError, match="school-mon.*execs.*not a list"):
        load_programs(pack)


@pytest.mark.parametrize("bad", [None, "", 0, {}])
def test_load_programs_rejects_a_falsy_non_list_execs(tmp_path, bad):
    """`"execs": null` is the same manifest typo wearing a falsy value.

    The guard used to read `if execs_raw and not isinstance(...)`, so every one
    of these slipped past it and reached `tuple(...)` — a TypeError naming
    neither the manifest nor the field, or (for `{}`) a silent empty tuple.
    """
    pack = _write_pack(tmp_path, {"id": "school-mon", "title": "M",
                                  "language": "basic", "binary": "school-mon",
                                  "node": {"execs": bad}})
    with pytest.raises(ValueError, match="school-mon.*execs.*not a list"):
        load_programs(pack)


def test_a_manifest_without_a_number_is_not_dialable(tmp_path):
    """The distinction the whole id-authority design rests on.

    `school` is built, golden-tested and reachable on the bus, but it has no
    `number` and so must not be dialable. A guard that tested directory
    existence instead would pass on exactly the bug that shipped: sims.ts
    naming `school` after the number moved to `school-mon`.
    """
    (tmp_path / "onbus" / "harness").mkdir(parents=True)
    (tmp_path / "onbus" / "harness" / "manifest.json").write_text(json.dumps({
        "id": "onbus", "title": "BUS ONLY", "language": "basic", "binary": "onbus",
    }))
    (tmp_path / "dialin" / "harness").mkdir(parents=True)
    (tmp_path / "dialin" / "harness" / "manifest.json").write_text(json.dumps({
        "id": "dialin", "title": "DIAL IN", "language": "basic", "binary": "dialin",
        "number": "(206) 555-0001",
    }))

    registry = load_systems(tmp_path)

    assert "dialin" in registry
    assert "onbus" not in registry, "a system with no number is not in the phone book"


def test_the_real_pack_matches_the_documented_dialable_set():
    """Guards the plan's own premise. If this list changes, the phone book
    changes with it — deliberately, via Task 3's generator."""
    registry = load_systems(PACK / "systems")
    assert set(registry) == {"airline", "pactel", "protovision", "reference", "school-mon",
                             "umb"}
