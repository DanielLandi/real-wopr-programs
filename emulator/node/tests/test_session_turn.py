import asyncio

import pytest

from app.execstack import Frame
from app.session_turn import run_session_turn
from app.systemwire import MAX_EXEC_DEPTH, SystemResponse


class FakeRunner:
    """Answers with a scripted SystemResponse per (program, command)."""

    def __init__(self, script):
        self.script = script
        self.calls = []

    async def run(self, system_id, command, state, user_input, timeout_s=None, reply=None):
        self.calls.append((system_id, command, state, user_input))
        return self.script[(system_id, command)]


def _resp(system_id, *, state="", display="", line="UP", prompt=None, exec_peer=None):
    return SystemResponse(system_id=system_id, state=state, display=display,
                          line=line, call=None, prompt=prompt, exec_peer=exec_peer)


def _timeout_for(_program):
    return 2.0


def _execs_for(program):
    return ("school",) if program == "school-mon" else ()


def test_exec_pushes_and_runs_the_child(tmp_path):
    runner = FakeRunner({
        ("school-mon", "INPUT"): _resp("school-mon", state="PHASE EXEC",
                                       display="", exec_peer="school"),
        ("school", "CONNECT"): _resp("school", state="STEP MENU",
                                     display="WELCOME TO DISTRICT DATANET",
                                     prompt="SELECT:"),
    })
    result = asyncio.run(run_session_turn(
        runner, [Frame("school-mon", "PHASE LOGIN")], "INPUT", "PENCIL",
        tmp_path, _timeout_for, _execs_for))

    assert result.display == "WELCOME TO DISTRICT DATANET"
    assert result.prompt == "SELECT:"
    assert result.line == "UP"
    assert result.frames == [Frame("school-mon", "PHASE EXEC"),
                             Frame("school", "STEP MENU")]
    # The child is entered with CONNECT and no user input.
    assert runner.calls[1] == ("school", "CONNECT", None, None)


def test_return_pops_and_resumes_the_parent_with_its_own_state(tmp_path):
    runner = FakeRunner({
        ("school", "INPUT"): _resp("school", state="STEP MENU",
                                   display="LOGGED OFF. GOODBYE.", line="RETURN"),
        ("school-mon", "RETURN"): _resp("school-mon", state="PHASE READY",
                                        display="", prompt="Ready"),
    })
    frames = [Frame("school-mon", "PHASE EXEC"), Frame("school", "STEP MENU")]
    result = asyncio.run(run_session_turn(runner, frames, "INPUT", "4", tmp_path,
                                          _timeout_for, _execs_for))

    assert result.line == "UP"
    assert result.prompt == "Ready"
    # Both displays are kept, in order.
    assert result.display == "LOGGED OFF. GOODBYE."
    assert result.frames == [Frame("school-mon", "PHASE READY")]
    # The parent is resumed with exactly the STATE it held at EXEC time.
    assert runner.calls[1] == ("school-mon", "RETURN", "PHASE EXEC", None)


def test_return_on_an_empty_stack_drops_the_line(tmp_path):
    """Captive-account behaviour: nothing beneath the program, so it ends the call."""
    runner = FakeRunner({
        ("school", "INPUT"): _resp("school", state="STEP MENU",
                                   display="LOGGED OFF. GOODBYE.", line="RETURN"),
    })
    result = asyncio.run(run_session_turn(runner, [Frame("school", "STEP MENU")],
                                          "INPUT", "4", tmp_path,
                                          _timeout_for, _execs_for))

    assert result.line == "DROP"
    assert result.display == "LOGGED OFF. GOODBYE."
    assert result.frames == []


def test_line_drop_ends_the_call_whatever_the_stack_holds(tmp_path):
    runner = FakeRunner({
        ("school", "INPUT"): _resp("school", state="STEP MENU",
                                   display="NO CARRIER", line="DROP"),
    })
    frames = [Frame("school-mon", "PHASE EXEC"), Frame("school", "STEP MENU")]
    result = asyncio.run(run_session_turn(runner, frames, "INPUT", "BYE", tmp_path,
                                          _timeout_for, _execs_for))
    assert result.line == "DROP"


def test_undeclared_exec_target_is_refused(tmp_path):
    runner = FakeRunner({
        ("school-mon", "INPUT"): _resp("school-mon", state="PHASE EXEC",
                                       exec_peer="payroll"),
    })
    with pytest.raises(ValueError, match="undeclared EXEC target"):
        asyncio.run(run_session_turn(runner, [Frame("school-mon", "PHASE LOGIN")],
                                     "INPUT", "PENCIL", tmp_path,
                                     _timeout_for, _execs_for))


def test_exec_depth_is_bounded_within_one_turn(tmp_path):
    """A program that execs itself forever must not hold the host in one turn."""
    runner = FakeRunner({
        ("loop", "INPUT"): _resp("loop", state="S", exec_peer="loop"),
        ("loop", "CONNECT"): _resp("loop", state="S", exec_peer="loop"),
    })
    result = asyncio.run(run_session_turn(runner, [Frame("loop", None)], "INPUT",
                                          "GO", tmp_path, _timeout_for,
                                          lambda p: ("loop",)))
    assert result.line == "DROP"
    assert len(result.frames) <= MAX_EXEC_DEPTH


def test_exec_depth_is_bounded_across_turns(tmp_path):
    """The bound is on stack DEPTH, not on pushes per turn.

    docs/systems.md §2.6: chained calls are bounded within one program's turn;
    the return stack is bounded across the session. A program that pushes only
    one frame per turn must still hit the ceiling — a per-turn counter would
    let it climb forever, one rung at a time.
    """
    runner = FakeRunner({
        ("loop", "INPUT"): _resp("loop", state="S", exec_peer="loop"),
        ("loop", "CONNECT"): _resp("loop", state="S", prompt="?"),
    })
    frames = [Frame("loop", "S")] * MAX_EXEC_DEPTH   # already at the ceiling
    result = asyncio.run(run_session_turn(runner, frames, "INPUT", "GO", tmp_path,
                                          _timeout_for, lambda p: ("loop",)))
    assert result.line == "DROP"
    # It refused to push a fifth frame rather than accepting one more per turn.
    assert len(result.frames) == MAX_EXEC_DEPTH
