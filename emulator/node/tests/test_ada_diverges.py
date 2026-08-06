"""ADAR11 divides by real attendance data (real-wopr#174).

The property a golden fixture cannot assert for itself: ADA sits strictly
below ADM. `01-ada-claim.out` pins the exact bytes; this pins the
*relationship*, so it stays meaningful if the register is ever regenerated.
Deliberately no hard-coded figures here — that is the golden's job.
"""
import subprocess
from pathlib import Path

import pytest

PACK = Path(__file__).resolve().parents[3]
BIN = PACK / "systems" / "school-ada" / "harness" / "bin" / "school-ada"

REQUEST = "SYSTEM/1 school-ada INPUT\nSTATE 0\nINPUT RUN ADAR11\nEND\n"


def run_adar11():
    """Run the claim and return its response lines.

    The wrapper chdirs to the program's own folder, so the cwd here is free.
    """
    if not BIN.exists():
        pytest.skip(f"{BIN} not built — run tools/build.sh")
    proc = subprocess.run([str(BIN)], input=REQUEST, capture_output=True,
                          text=True, timeout=30)
    assert proc.returncode == 0, proc.stderr
    return proc.stdout.splitlines()


def building_line(lines):
    """The single building's report row: BUILDING ENROLLED ADM ADA."""
    rows = [l for l in lines if l.startswith("HIGH")]
    assert len(rows) == 1, lines
    return rows[0]


def district_line(lines):
    rows = [l for l in lines if l.startswith("DISTRICT")]
    assert len(rows) == 1, lines
    return rows[0]


def test_building_ada_is_strictly_below_adm():
    fields = building_line(run_adar11()).split()
    assert len(fields) == 4, fields
    adm, ada = float(fields[2]), float(fields[3])
    assert ada < adm, f"ADA {ada} must sit below ADM {adm} — is ABSENC.DAT being read?"


def test_district_ada_is_strictly_below_adm():
    fields = district_line(run_adar11()).split()
    assert len(fields) == 3, fields
    adm, ada = float(fields[1]), float(fields[2])
    assert ada < adm, f"district ADA {ada} must sit below ADM {adm}"


def test_the_claim_is_no_longer_provisional():
    lines = run_adar11()
    assert not any("PROVISIONAL" in l for l in lines), lines


def test_the_declared_display_count_matches_the_body():
    """A wrong DISPLAY count desynchronises the wire; the count and the body
    have to move together when the provisional line comes out."""
    lines = run_adar11()
    declared = next(int(l.split()[1]) for l in lines if l.startswith("DISPLAY "))
    start = next(i for i, l in enumerate(lines) if l.startswith("DISPLAY ")) + 1
    end = next(i for i, l in enumerate(lines) if l == "LINE UP")
    assert declared == end - start, lines
