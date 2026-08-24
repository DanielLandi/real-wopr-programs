"""The generated .dat files are bound to the generator (#57).

`tools/gen-systems-data.py` writes seven committed data files, and nothing
asserted that what is committed is what the generator currently produces.
The invariant checks in test_gen_absences.py get close but cannot close it:
a drift that still satisfies an invariant passes green — a hand-edited .dat,
a changed MONTH_WEIGHT or SEED, or a generator call inserted anywhere but
last in main() (which shifts every subsequent draw off the one shared PRNG).

The pack already had the pattern in tools/gen-dial-directory.py --check:
regenerate, diff against what is committed, fail on drift. This is the same
guarantee for the data files.
"""
import importlib.util
from pathlib import Path

PACK = Path(__file__).resolve().parents[3]

spec = importlib.util.spec_from_file_location("gsd", PACK / "tools" / "gen-systems-data.py")
gsd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gsd)


def test_committed_data_files_match_the_generator():
    """The regenerate-and-diff guarantee, asserted directly."""
    assert gsd.main(["--check"]) == 0, \
        "committed .dat files are stale — run tools/gen-systems-data.py"


def test_check_notices_a_hand_edited_file(tmp_path, capsys):
    """The check has to actually discriminate. Render everything, corrupt one
    byte of one file on the way to disk, and the comparison must name it."""
    rendered = gsd.render_all()
    assert rendered, "render_all returned nothing"
    victim = next(p for p in rendered if p.name == "students.dat")
    tampered = dict(rendered)
    tampered[victim] = "0000 NOBODY" + tampered[victim][11:]
    stale = gsd.stale_files(tampered)
    assert stale == [victim], stale


# Committed .dat files that are authored by hand, not drawn. Listed rather
# than pattern-matched so that a new data file has to be classified as one or
# the other on the way in: an unrendered file is one --check cannot guard.
HAND_MAINTAINED = {
    "systems/school-ada/data/calend.dat",    # the calendar the draw is against
    "systems/school-mon/data/acct.dat",      # the monitor's account table
    "systems/school-mon/data/catlog.dat",    # its disk catalogue
    "systems/pactel/data/accounts.dat",      # Pacific Telephone's subscribers
    "systems/pactel/data/calls.dat",         # and their toll records
    "systems/umb/data/accounts.dat",         # Union Marine Bank's depositors
    "systems/umb/data/history.dat",          # and their transaction ledger
}


def test_every_committed_dat_file_is_either_generated_or_declared_by_hand():
    """A file the generator writes but does not render is a file --check
    silently ignores, which is the hole this closes. The inverse matters too:
    a hand-authored file that drifts into render_all would be overwritten."""
    rendered = {p.resolve() for p in gsd.render_all()}
    by_hand = {(PACK / rel).resolve() for rel in HAND_MAINTAINED}
    on_disk = {p.resolve() for p in PACK.glob("systems/*/data/*.dat")}

    assert on_disk == rendered | by_hand, (
        "unclassified data file(s): %r — add to render_all() or to "
        "HAND_MAINTAINED" % (on_disk ^ (rendered | by_hand),)
    )
    assert not (rendered & by_hand), \
        "declared hand-maintained but generated: %r" % (rendered & by_hand,)


def test_main_rejects_an_unrecognised_argument(capsys):
    """A mistyped flag must not fall through to write mode and rewrite the
    committed data — in CI that would go green while guarding nothing."""
    before = {p: p.read_text() for p in gsd.render_all()}
    rc = gsd.main(["--chek"])
    assert rc != 0
    assert "--chek" in capsys.readouterr().err
    for p, text in before.items():
        assert p.read_text() == text, "must not write %s on a bad argument" % p
