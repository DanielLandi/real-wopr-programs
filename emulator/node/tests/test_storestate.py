"""Store state: the difference between a database and a subroutine.

A node declaring `state: persistent` has its STATE owned by its host between
calls, instead of every caller carrying the whole record file back and forth.
This is the access-method distinction — IMS DB and VSAM owned their datasets;
application programs named records.
"""

from __future__ import annotations

from pathlib import Path

from app.storestate import StoreState


def test_a_store_remembers_across_separate_calls(tmp_path: Path):
    a = StoreState(tmp_path, "school-db")
    assert a.load() is None
    a.save("GRD 1 BIOLOGY 2 A")

    # A different instance: the next call, or the next process.
    b = StoreState(tmp_path, "school-db")
    assert b.load() == "GRD 1 BIOLOGY 2 A"


def test_saving_again_replaces_rather_than_appends(tmp_path: Path):
    s = StoreState(tmp_path, "school-db")
    s.save("GRD 1 BIOLOGY 2 A")
    s.save("GRD 1 BIOLOGY 2 B")
    assert StoreState(tmp_path, "school-db").load() == "GRD 1 BIOLOGY 2 B"


def test_multi_line_state_round_trips_exactly(tmp_path: Path):
    body = "GRD 1 BIOLOGY 2 A\nGRD 2 ALGEBRA 2 B"
    StoreState(tmp_path, "school-db").save(body)
    assert StoreState(tmp_path, "school-db").load() == body


def test_reset_clears_it(tmp_path: Path):
    s = StoreState(tmp_path, "school-db")
    s.save("GRD 1 BIOLOGY 2 A")
    s.reset()
    assert s.load() is None


def test_reset_on_a_store_that_never_saved_is_not_an_error(tmp_path: Path):
    StoreState(tmp_path, "school-db").reset()


def test_empty_state_is_saved_as_empty_not_as_absent(tmp_path: Path):
    """A store that has emptied itself is not the same as one never written."""
    s = StoreState(tmp_path, "school-db")
    s.save("")
    assert s.load() == ""


def test_an_unreadable_file_resets_rather_than_crashing_the_node(tmp_path: Path):
    """Corruption should cost a store its memory, not take the node down."""
    s = StoreState(tmp_path, "school-db")
    s.save("GRD 1 BIOLOGY 2 A")
    s.path.write_bytes(b"\xff\xfe\x00 not valid ascii")
    assert s.load() is None


def test_two_stores_do_not_share_a_file(tmp_path: Path):
    StoreState(tmp_path, "school-db").save("SCHOOL")
    StoreState(tmp_path, "other-db").save("OTHER")
    assert StoreState(tmp_path, "school-db").load() == "SCHOOL"


def test_the_path_is_namespaced_under_the_runtime_dir(tmp_path: Path):
    s = StoreState(tmp_path, "school-db")
    assert s.path == tmp_path / "state" / "school-db.state"


def test_a_node_id_cannot_escape_the_runtime_dir(tmp_path: Path):
    """The id comes from a manifest; a manifest is not a licence to write
    anywhere on the disk."""
    s = StoreState(tmp_path, "../../etc/passwd")
    assert tmp_path in s.path.parents
