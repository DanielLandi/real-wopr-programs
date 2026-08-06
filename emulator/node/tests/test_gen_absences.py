"""The attendance register ADAR11 divides by (real-wopr#174)."""
import importlib.util
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("gsd", ROOT / "tools" / "gen-systems-data.py")
gsd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gsd)

MONTHS = ["SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN"]

CALEND = ROOT / "systems" / "school-ada" / "data" / "calend.dat"
ABSENC = ROOT / "systems" / "school-ada" / "data" / "absenc.dat"


def roster_ids():
    lines = (ROOT / "systems" / "school" / "data" / "students.dat").read_text().splitlines()
    return [int(l[0:4]) for l in lines]


def instructional_days(text=None):
    """{month: days} read off CALEND.DAT, the calendar ADAR11 itself divides
    by — never hard-coded here, so this stays true if the calendar changes.

    Layout mirrors main.bas' 8600 loader: cols 1-3 month, 5-10 building,
    12-13 instructional days.

    A pupil attends exactly one building, so "the month's instructional
    days" is only a well-defined number while the calendar carries one row
    per month. main.bas' 4040 refuses to run otherwise (NB <> 1 -> 7000)
    for the same reason: the roster has no building column to split the
    headcount by. This refuses too, rather than collapsing the rows to the
    longest of them — a clamp built from the wrong building's month would
    pass every caller here silently (real-wopr-programs#58).
    """
    days = {}
    for line in (CALEND.read_text() if text is None else text).splitlines():
        if not line.strip():
            continue
        month, n = line[0:3], int(line[11:13])
        if month in days:
            raise ValueError(
                "CALEND.DAT gives %s more than one row, so a pupil's month is "
                "ambiguous; this helper needs one row per month (and the "
                "register's clamp needs to become per-building)" % month
            )
        days[month] = n
    return days


def test_absences_cover_every_student_and_month():
    import random
    rows = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    assert len(rows) == len(roster_ids()) * len(MONTHS)
    seen = {(sid, m) for sid, m, _ in rows}
    assert seen == {(sid, m) for sid in roster_ids() for m in MONTHS}


def test_absence_days_are_plausible_and_nonzero_overall():
    import random
    rows = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    cal = instructional_days()
    over = [(sid, m, d) for sid, m, d in rows if not 0 <= d <= cal[m]]
    assert not over, (
        "no clerk could key more days absent than the month held: "
        + ", ".join("%04d %s %d > %d" % (s, m, d, cal[m]) for s, m, d in over[:5])
    )
    assert sum(d for _, _, d in rows) > 0, \
        "with no absences at all, ADA would still equal ADM"


def test_committed_register_is_keyable():
    """The shipped file, not a fresh draw. Every other test here re-runs
    gen_absences off a fresh Random(SEED), which is NOT the post-roster PRNG
    state main() reaches — so the rows they check are not the rows that ship.
    This one reads the committed register and holds every row to its own
    month's instructional days (real-wopr#174 review, Finding 1)."""
    cal = instructional_days()
    lines = ABSENC.read_text().splitlines()
    assert lines, "absenc.dat is empty"
    over = []
    for line in lines:
        sid, month, days = int(line[0:4]), line[5:8], int(line[9:11])
        assert month in cal, "%s names a month CALEND.DAT does not have" % line
        if not 0 <= days <= cal[month]:
            over.append((sid, month, days))
    assert not over, (
        "committed absenc.dat rows exceed their month's instructional days: "
        + ", ".join("%04d %s %d > %d" % (s, m, d, cal[m]) for s, m, d in over[:5])
    )


def test_instructional_days_refuses_a_multi_building_calendar():
    """Taking max() across buildings answers for the wrong one. A pupil
    attends exactly one building, so a per-month ceiling is only meaningful
    while the calendar carries exactly one row per month — which is precisely
    what main.bas' 4040 refuses to proceed without (NB <> 1 -> 7000), because
    the roster has no building column to split the headcount by.

    So the helper must not quietly clamp every pupil to the longest building's
    month. The day a second building lands, this fails loudly and points at
    the register's per-month clamp needing to become per-building too."""
    two_buildings = "SEP HIGH   20\nSEP WEST   18\n"
    with pytest.raises(ValueError, match="one row per month"):
        instructional_days(two_buildings)


def test_generation_is_deterministic():
    import random
    a = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    b = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    assert a == b
