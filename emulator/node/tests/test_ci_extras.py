"""The `node` CI job must actually run the tests it reports as green.

`anthropic` is a `prod` extra and the job installed `[dev]`, so both
`test_joshua_claude.py` and `test_joshua_claude_seeks.py` skipped at import on
every run — five tests, including the two that pin the Claude engine's whole
contribution to the callback (`seek_falken` reaching `JoshuaReply.seeks`). A
suite that skips silently reports coverage it does not have, which is worse
than not having the tests at all (#78 item 4).

Installing the extra fixes today. This file is what keeps it fixed: the failure
mode is silent by construction, so someone trimming the install line back to
`[dev]` for build time would get a green run and no signal — exactly how it
shipped the first time. Here that trim fails a test with a name that says why.

`yaml` arrives with `uvicorn[standard]`, a hard dependency of this package, so
it is present in any install that can run the suite at all.
"""

from __future__ import annotations

import pathlib

import pytest

yaml = pytest.importorskip("yaml")

WORKFLOW = pathlib.Path(__file__).resolve().parents[3] / ".github" / "workflows" / "ci.yml"

#: The environment variable the guard in conftest.py reads. Named here rather
#: than imported so that renaming it in one place fails this test rather than
#: quietly disarming the guard in CI.
REQUIRE_FLAG = "WOPR_REQUIRE_PROD_EXTRAS"


@pytest.fixture(scope="module")
def node_job() -> dict:
    assert WORKFLOW.is_file(), f"the pack workflow moved: {WORKFLOW}"
    jobs = yaml.safe_load(WORKFLOW.read_text())["jobs"]
    assert "node" in jobs, "the `node` job is one of the nine required checks"
    return jobs["node"]


def test_the_node_job_installs_the_prod_extra(node_job: dict) -> None:
    """Without it, every `anthropic`-gated module skips and CI is green anyway."""
    installs = [
        step["run"] for step in node_job["steps"]
        if "run" in step and "emulator/node[" in step["run"]
    ]
    assert installs, "the node job no longer installs the node host"
    assert any("prod" in run for run in installs), (
        "the node job must install the `prod` extra — without `anthropic`, "
        "test_joshua_claude*.py skip at import and the run is green regardless"
    )


def test_the_node_job_demands_the_prod_extra(node_job: dict) -> None:
    """The install alone can be trimmed away silently; the flag cannot.

    With it set, conftest.py refuses to run the suite at all when a prod extra
    is missing — so a job that stops installing them fails loudly instead of
    reporting a green run over five skipped tests.
    """
    env = {**node_job.get("env", {})}
    for step in node_job["steps"]:
        env.update(step.get("env", {}))
    assert str(env.get(REQUIRE_FLAG, "")) == "1", (
        f"the node job must set {REQUIRE_FLAG}=1 so a missing prod extra is a "
        "failure rather than a silent skip"
    )
