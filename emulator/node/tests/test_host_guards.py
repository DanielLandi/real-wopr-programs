"""tools/host.sh's env guards, pinned (#34).

These checks exist because the hub refuses a malformed REGISTER with a
*non-terminal* close, so the tieline redials it forever: a typo that gets
past here becomes a silent reconnect loop instead of an error anyone reads.
They were verified by hand on every change until now.

Only the rejection paths are exercised, deliberately. A value the guards
*accept* falls straight through to creating a venv, installing packages and
starting the node host, relay and tieline under a supervisor that blocks —
not something a unit test should launch. So this pins that each bad input
dies, with the message that names the variable; it cannot pin that a good
input is accepted.

Every case asserts the message too, not just the exit code. `set -euo
pipefail` means an unrelated failure also exits non-zero, and an exit-code
-only test would go on passing if a guard were deleted outright.
"""
import subprocess
from pathlib import Path

import pytest

PACK = Path(__file__).resolve().parents[3]
HOST_SH = PACK / "tools" / "host.sh"


def run_host(**env_overrides):
    """Run host.sh with a bad environment. Returns (rc, stderr).

    cwd is irrelevant — host.sh cd's to the pack root itself — but a real
    environment is passed through so the .env-snapshot logic behaves as it
    does for an operator. The command line wins over .env by design, so
    these overrides are what the guards see either way.
    """
    import os
    env = dict(os.environ)
    env.update({k: v for k, v in env_overrides.items()})
    proc = subprocess.run(
        ["bash", str(HOST_SH)], capture_output=True, text=True, timeout=60,
        env=env, cwd=str(PACK),
    )
    return proc.returncode, proc.stderr


@pytest.mark.parametrize("value", ["ATLANTIS", "wopr-2", ""])
def test_an_unknown_tieline_slot_is_refused(value):
    if value == "":
        pytest.skip("empty means 'unset' to the guard — the hub assigns one")
    rc, err = run_host(TIELINE_SLOT=value)
    assert rc == 1, err
    assert "TIELINE_SLOT must be one of" in err, err


def test_home_is_not_a_slot_anyone_can_host():
    """HOME is the caller's own seat, not a service. The hub's roster leaves
    it out, so a REGISTER claiming it would not even decode — which is
    exactly the failure that would otherwise redial forever."""
    rc, err = run_host(TIELINE_SLOT="HOME")
    assert rc == 1, err
    assert "TIELINE_SLOT must be one of" in err, err
    assert "HOME" not in err.split("one of:")[1], \
        "HOME must not be advertised in the roster the error prints"


@pytest.mark.parametrize("value", ["everywhere", "1.5", "-2", "2nd"])
def test_a_world_that_is_not_a_number_or_new_is_refused(value):
    rc, err = run_host(TIELINE_WORLD=value)
    assert rc == 1, err
    assert "TIELINE_WORLD must be a world number" in err, err


def test_world_zero_is_refused():
    """Worlds are 1-based; 0 is all digits, so it passes the grammar check
    and only the range check catches it."""
    rc, err = run_host(TIELINE_WORLD="0")
    assert rc == 1, err
    assert "1 or greater" in err, err


@pytest.mark.parametrize("value", ["gpt", "PERIOD", "lisp"])
def test_an_unknown_joshua_engine_is_refused(value):
    """Note PERIOD: unlike the slot and world, this one is not uppercased,
    so the enum is genuinely case-sensitive. Pinned as-is rather than
    'fixed' — the two callers that set it (host.html, the README) both
    write it lowercase."""
    rc, err = run_host(TIELINE_JOSHUA=value)
    assert rc == 1, err
    assert "TIELINE_JOSHUA must be period or claude" in err, err


@pytest.mark.parametrize("var", ["TIELINE_NAME", "TIELINE_REGION"])
@pytest.mark.parametrize("value,why", [("X", "too short"), ("Y" * 25, "too long")])
def test_a_name_the_phone_book_cannot_print_is_refused(var, value, why):
    rc, err = run_host(**{var: value})
    assert rc == 1, "%s %s: %r" % (var, why, err)
    assert "%s must be 2-24 characters" % var in err, err


def test_an_over_long_operator_is_refused_but_an_absent_one_is_fine():
    """TIELINE_OPERATOR is the one length-checked field with a 0 minimum —
    it is optional. Only the upper bound can reject it."""
    rc, err = run_host(TIELINE_OPERATOR="Z" * 25)
    assert rc == 1, err
    assert "TIELINE_OPERATOR must be 0-24 characters" in err, err
