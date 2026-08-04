import json

import pytest

from app.systems import Program, load_programs, load_systems, validate_execs


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
