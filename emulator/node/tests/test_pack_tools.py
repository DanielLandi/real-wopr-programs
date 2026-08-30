"""tools/{categories,build,test,behavior}.sh learn the pack's categories from pack.json.

They used to restate the list (`games systems joshua wopr`) by hand, the same
drift surface that bit the engine repo's import script when `wopr/` arrived
(real-wopr#206). The scripts are exercised here against a throwaway pack whose
categories exist nowhere in this repo, so a hard-coded list cannot pass.
"""
import json
import os
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

PACK = Path(__file__).resolve().parents[3]
TOOLS = ("categories.sh", "build.sh", "test.sh", "behavior.sh")


def _sh(path: Path, body: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def _program(root: Path, rel: str, binary: str) -> None:
    """A program at `rel` whose binary echoes its input, with one golden."""
    h = root / rel / "harness"
    _sh(h / "build.sh", f'mkdir -p "$(dirname "$0")/bin" && '
                        f'printf \'#!/bin/sh\\ncat\\n\' > "$(dirname "$0")/bin/{binary}" && '
                        f'chmod +x "$(dirname "$0")/bin/{binary}"\n')
    (h / "manifest.json").write_text(json.dumps({"id": binary, "binary": binary}))
    (h / "tests").mkdir()
    (h / "tests" / "01-echo.in").write_text("HELLO\n")
    (h / "tests" / "01-echo.out").write_text("HELLO\n")


@pytest.fixture
def mini_pack(tmp_path: Path) -> Path:
    """Two categories at the contract's three depths, plus a decoy that is not one."""
    root = tmp_path / "pack"
    (root / "tools").mkdir(parents=True)
    for t in TOOLS:
        shutil.copy(PACK / "tools" / t, root / "tools" / t)
    _program(root, "zz/alpha", "alpha")            # <cat>/<id>/harness
    _program(root, "zz/beta/core", "beta")         # <cat>/<id>/<interpretation>/harness
    _program(root, "solo", "solo")                 # <cat>/harness
    # A harness-shaped directory in an undeclared category must never be swept in.
    _sh(root / "emulator/harness/build.sh", 'touch "$(dirname "$0")/RAN"\n')
    (root / "pack.json").write_text(json.dumps({"programs": [
        {"id": "alpha", "path": "zz/alpha"},
        {"id": "beta", "path": "zz/beta"},
        {"id": "solo", "path": "solo"},
    ]}))
    return root


def run(root: Path, tool: str, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run([str(root / "tools" / tool), *args], capture_output=True, text=True)


def test_categories_are_derived_from_pack_json(mini_pack: Path):
    out = run(mini_pack, "categories.sh")
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == ["solo", "zz"]


def test_categories_of_the_real_pack_match_pack_json():
    declared = sorted({p["path"].split("/")[0]
                       for p in json.loads((PACK / "pack.json").read_text())["programs"]})
    out = run(PACK, "categories.sh")
    assert out.returncode == 0, out.stderr
    assert out.stdout.split() == declared
    assert "wopr" in declared  # the fourth category, the one the hand-kept lists missed


def test_build_runs_every_declared_harness_and_no_other(mini_pack: Path):
    out = run(mini_pack, "build.sh")
    assert out.returncode == 0, out.stderr
    for b in ("zz/alpha/harness/bin/alpha", "zz/beta/core/harness/bin/beta", "solo/harness/bin/solo"):
        assert os.access(mini_pack / b, os.X_OK), b
    assert not (mini_pack / "emulator/harness/RAN").exists()


def test_golden_test_covers_every_category_by_default(mini_pack: Path):
    run(mini_pack, "build.sh")
    out = run(mini_pack, "test.sh")
    assert out.returncode == 0, out.stdout + out.stderr
    assert "golden: 3 passed, 0 failed" in out.stdout


def test_golden_test_filters_by_declared_category(mini_pack: Path):
    run(mini_pack, "build.sh")
    out = run(mini_pack, "test.sh", "zz")
    assert out.returncode == 0, out.stdout + out.stderr
    assert "golden: 2 passed, 0 failed" in out.stdout


def test_golden_test_rejects_an_undeclared_category(mini_pack: Path):
    out = run(mini_pack, "test.sh", "bogus")
    assert out.returncode == 2
    assert "pack declares: solo zz" in out.stderr


def test_golden_test_still_fails_on_a_wrong_fixture(mini_pack: Path):
    run(mini_pack, "build.sh")
    (mini_pack / "solo/harness/tests/01-echo.out").write_text("GOODBYE\n")
    out = run(mini_pack, "test.sh")
    assert out.returncode == 1
    assert "FAIL solo/01-echo" in out.stdout


def test_behavior_walks_every_declared_category_and_no_other(mini_pack: Path):
    # behavior.sh used to glob games/* alone (#104); it now walks the declared
    # categories at all three depths, and never an undeclared harness.
    for rel in ("zz/alpha", "zz/beta/core", "solo"):
        _sh(mini_pack / rel / "harness/selfplay.sh", 'echo "SELFPLAY $0"\n')
    _sh(mini_pack / "solo/harness/convergence.sh", 'echo "CONVERGE $0"\n')
    _sh(mini_pack / "emulator/harness/selfplay.sh", 'touch "$(dirname "$0")/BEHAVED"\n')
    out = run(mini_pack, "behavior.sh")
    assert out.returncode == 0, out.stdout + out.stderr
    for rel in ("zz/alpha", "zz/beta/core", "solo"):
        assert f"== {rel}/harness/selfplay.sh ==" in out.stdout
    assert "== solo/harness/convergence.sh ==" in out.stdout
    assert not (mini_pack / "emulator/harness/BEHAVED").exists()


def test_behavior_reports_a_failing_check(mini_pack: Path):
    _sh(mini_pack / "zz/alpha/harness/selfplay.sh", "exit 1\n")
    out = run(mini_pack, "behavior.sh")
    assert out.returncode == 1
    assert "BEHAVIOR FAILED: zz/alpha/harness/selfplay.sh" in out.stderr
