"""The attendance register ADAR11 divides by (real-wopr#174)."""
import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("gsd", ROOT / "tools" / "gen-systems-data.py")
gsd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gsd)

MONTHS = ["SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN"]


def roster_ids():
    lines = (ROOT / "systems" / "school" / "data" / "students.dat").read_text().splitlines()
    return [int(l[0:4]) for l in lines]


def test_absences_cover_every_student_and_month():
    import random
    rows = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    assert len(rows) == len(roster_ids()) * len(MONTHS)
    seen = {(sid, m) for sid, m, _ in rows}
    assert seen == {(sid, m) for sid in roster_ids() for m in MONTHS}


def test_absence_days_are_plausible_and_nonzero_overall():
    import random
    rows = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    days = [d for _, _, d in rows]
    assert all(0 <= d <= 99 for d in days), "a month cannot hold a two-digit-overflow absence"
    assert sum(days) > 0, "with no absences at all, ADA would still equal ADM"


def test_generation_is_deterministic():
    import random
    a = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    b = gsd.gen_absences(random.Random(gsd.SEED), roster_ids())
    assert a == b
