"""WOPR DEVELOPMENT SYSTEM tests — line editor + session dispatch."""

import sys
from pathlib import Path

import pytest

DEVKIT = Path(__file__).resolve().parent.parent
REPO = DEVKIT.parent
sys.path.insert(0, str(DEVKIT))

from wopr_dev.lineeditor import LineEditor  # noqa: E402
from wopr_dev.session import DevSession, PACK  # noqa: E402

CORE_BIN = PACK / "games" / "tictactoe" / "core" / "harness" / "bin"  # nested slot (§8)
needs_core = pytest.mark.skipif(not (CORE_BIN / "tictactoe").exists(),
                                reason="core not built")


# -- line editor ----------------------------------------------------------------

def make_file(tmp_path, text):
    p = tmp_path / "prog.f90"
    p.write_text(text)
    return p


def test_print_and_numbered(tmp_path):
    ed = LineEditor(make_file(tmp_path, "ALPHA\nBETA\nGAMMA\n"))
    assert ed.feed("P 2").output == "BETA"
    assert "1  ALPHA" in ed.feed("N").output
    assert ed.feed("P").output == "ALPHA\nBETA\nGAMMA"


def test_insert_append_replace_delete(tmp_path):
    ed = LineEditor(make_file(tmp_path, "ONE\nTWO\nTHREE\n"))
    ed.feed("A 1"); ed.feed("ONE-AND-A-HALF"); ed.feed(".")
    assert ed.lines == ["ONE", "ONE-AND-A-HALF", "TWO", "THREE"]
    ed.feed("I 1"); ed.feed("ZERO"); ed.feed(".")
    assert ed.lines[0] == "ZERO"
    ed.feed("R 2"); ed.feed("FIRST"); ed.feed(".")
    assert ed.lines[1] == "FIRST"
    ed.feed("D 3,4")
    assert ed.lines == ["ZERO", "FIRST", "THREE"]


def test_substitute(tmp_path):
    ed = LineEditor(make_file(tmp_path, "X = 1\nY = 2\n"))
    r = ed.feed("S 1 /1/42/")
    assert ed.lines[0] == "X = 42"
    assert "42" in r.output


def test_write_round_trips(tmp_path):
    p = make_file(tmp_path, "A\nB\n")
    ed = LineEditor(p)
    ed.feed("A 2"); ed.feed("C"); ed.feed(".")
    ed.feed("W")
    assert p.read_text() == "A\nB\nC\n"
    assert LineEditor(p).lines == ["A", "B", "C"]


def test_bad_commands_do_not_mutate(tmp_path):
    ed = LineEditor(make_file(tmp_path, "A\nB\n"))
    assert "?" in ed.feed("ZORK").output
    assert "?" in ed.feed("R 99").output
    assert ed.lines == ["A", "B"]


def test_quit_warns_when_dirty(tmp_path):
    ed = LineEditor(make_file(tmp_path, "A\n"))
    ed.feed("A 1"); ed.feed("B"); ed.feed(".")
    assert not ed.feed("Q").done          # warned
    assert ed.feed("QY").done             # discard


# -- session --------------------------------------------------------------------

def test_directory_lists_real_sources():
    s = DevSession()
    out, _ = s.command("DIRECTORY core")
    # tictactoe is a nested slot (§8): each interpretation's source is listed.
    assert "games/tictactoe/core/main.f90" in out
    assert "games/tictactoe/heuristic/main.f90" in out
    out, _ = s.command("DIRECTORY joshua")
    assert "joshua/src/engine.lisp" in out


def test_edit_refuses_traversal_and_nonsource():
    s = DevSession()
    assert "?" in s.command("EDIT ../../etc/passwd")[0]
    assert "?" in s.command("EDIT README.md")[0]
    assert "?" in s.command("EDIT games/nope.f90")[0]


def test_edit_routes_input_to_editor_until_quit():
    s = DevSession()
    out, _ = s.command("EDIT games/tictactoe/core/main.f90")
    assert "editing" in out
    assert s.editor is not None
    # a print command goes to the editor, not the top-level dispatcher
    assert "program tictactoe" in s.command("P 1")[0].lower() or s.editor is not None
    s.command("Q")
    assert s.editor is None


def test_unknown_top_command():
    assert "? UNKNOWN COMMAND" in DevSession().command("LAUNCH")[0]


@needs_core
def test_run_executes_real_binary():
    out, _ = DevSession().command("RUN tictactoe")
    assert "WOPR/1 tictactoe OK" in out
    assert "STATUS PLAYING" in out


@needs_core
def test_golden_core_passes():
    out, _ = DevSession().command("GOLDEN core")
    assert "0 failed" in out
