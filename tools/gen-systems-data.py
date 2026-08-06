#!/usr/bin/env python3
"""Generate the systems' fixed-width data files (run once; output is committed).

This is the ONE deliberately modern artifact in the data path: a seeded
generator that writes the 1983-shaped flat files the period programs load at
startup. It is not part of any build or runtime path — the .dat files it
writes are committed, and the programs only ever read those.

    tools/gen-systems-data.py          # rewrites every systems data file

Determinism: everything is drawn from random.Random(SEED) with SEED = 1983.
Re-running the script reproduces the committed files byte-for-byte. If you
change the script, re-run it, re-run the golden fixtures, and review every
fixture diff line by line — the data files are part of the observable
behavior of the systems.

Canonical records (the two students and the six flights the golden fixtures
were written against) are pinned first, verbatim, before anything is drawn
from the PRNG. Do not reorder them.

Files written (fixed-width, one record per line, ASCII, LF):

  systems/airline/data/flights.dat
    1-6 pair  8-10 orig  12-14 dest  16-20 key  22-27 disp
    29-32 dep  34-39 arr  41 arrlen  43-50 seats
  systems/airline/data/passengers.dat
    1-26 name  28-32 flight key  34 class  36-40 date
  systems/school/data/students.dat
    1-4 id  6-35 name  37-38 grade level (left-justified)
  systems/school/data/courses.dat
    1-14 course  16-21 room  23-34 teacher
  systems/school/data/schedule.dat
    1-4 id  6-19 course
  systems/school-db/data/grades.dat
    1-4 id  6-19 course  21 grade
  systems/school-ada/data/absenc.dat
    1-4 id  6-8 month  10-11 days absent
"""

from __future__ import annotations

import random
from pathlib import Path

SEED = 1983
ROOT = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# name pools — deliberately 1983-plausible; no film names beyond the two the
# repo already carries (LIGHTMAN, MACK stay out of the pools so the pinned
# records remain the only ones).
# ---------------------------------------------------------------------------

SURNAMES = [
    "SMITH", "JOHNSON", "WILLIAMS", "BROWN", "JONES", "MILLER", "DAVIS",
    "WILSON", "ANDERSON", "TAYLOR", "THOMAS", "MOORE", "MARTIN", "JACKSON",
    "THOMPSON", "WHITE", "HARRIS", "CLARK", "LEWIS", "WALKER", "HALL",
    "YOUNG", "ALLEN", "KING", "WRIGHT", "SCOTT", "GREEN", "BAKER", "ADAMS",
    "NELSON", "HILL", "CAMPBELL", "MITCHELL", "ROBERTS", "CARTER",
    "PHILLIPS", "EVANS", "TURNER", "PARKER", "COLLINS", "EDWARDS",
    "STEWART", "MORRIS", "ROGERS", "REED", "COOK", "MORGAN", "BELL",
    "MURPHY", "BAILEY", "RIVERA", "COOPER", "RICHARDSON", "COX", "HOWARD",
    "WARD", "PETERSON", "GRAY", "RAMIREZ", "WATSON", "BROOKS", "KELLY",
    "SANDERS", "PRICE", "BENNETT", "WOOD", "BARNES", "ROSS", "HENDERSON",
    "COLEMAN", "JENKINS", "PERRY", "POWELL", "LONG", "PATTERSON", "HUGHES",
    "FLORES", "WASHINGTON", "BUTLER", "SIMMONS", "FOSTER", "GONZALES",
    "BRYANT", "ALEXANDER", "RUSSELL", "GRIFFIN", "DIAZ", "HAYES", "MYERS",
    "FORD", "HAMILTON", "GRAHAM", "SULLIVAN", "WALLACE", "WOODS", "COLE",
    "WEST", "JORDAN", "OWENS", "REYNOLDS", "FISHER", "ELLIS", "HARRISON",
    "GIBSON", "MCDONALD", "CRUZ", "MARSHALL", "ORTIZ", "GOMEZ", "MURRAY",
    "FREEMAN", "WELLS", "WEBB", "SIMPSON", "STEVENS", "TUCKER", "PORTER",
    "HUNTER", "HICKS", "CRAWFORD", "HENRY", "BOYD", "MASON", "MORALES",
    "KENNEDY", "WARREN", "DIXON", "RAMOS", "REYES", "BURNS", "GORDON",
    "SHAW", "HOLMES", "RICE", "ROBERTSON", "HUNT", "BLACK", "DANIELS",
    "PALMER", "MILLS", "NICHOLS", "GRANT", "KNIGHT", "FERGUSON", "ROSE",
    "STONE", "HAWKINS", "DUNN", "PERKINS", "HUDSON", "SPENCER", "GARDNER",
    "STEPHENS", "PAYNE", "PIERCE", "BERRY", "MATTHEWS", "ARNOLD", "WAGNER",
    "WILLIS", "RAY", "WATKINS", "OLSON", "CARROLL", "DUNCAN", "SNYDER",
    "HART", "CUNNINGHAM", "BRADLEY", "LANE", "ANDREWS", "RUIZ", "HARPER",
    "FOX", "RILEY", "ARMSTRONG", "CARPENTER", "WEAVER", "GREENE",
    "LAWRENCE", "ELLIOTT", "CHAVEZ", "SIMS", "AUSTIN", "PETERS", "KELLEY",
    "FRANKLIN", "LAWSON", "FIELDS", "GUTIERREZ", "RYAN", "SCHMIDT",
    "CARR", "VASQUEZ", "CASTILLO", "WHEELER", "CHAPMAN", "OLIVER",
    "MONTGOMERY", "RICHARDS", "WILLIAMSON", "JOHNSTON", "BANKS", "MEYER",
    "BISHOP", "MCCOY", "HOWELL", "ALVAREZ", "MORRISON", "HANSEN",
    "FERNANDEZ", "GARZA", "HARVEY", "LITTLE", "BURTON", "STANLEY",
    "NGUYEN", "GEORGE", "JACOBS", "REID", "KIM", "FULLER", "LYNCH",
    "DEAN", "GILBERT", "GARRETT", "ROMERO", "WELCH", "LARSON", "FRAZIER",
    "BURKE", "HANSON", "DAY", "MENDOZA", "MORENO", "BOWMAN", "MEDINA",
    "FOWLER", "BREWER", "HOFFMAN", "CARLSON", "SILVA", "PEARSON",
    "HOLLAND", "DOUGLAS", "FLEMING", "JENSEN", "VARGAS", "BYRD",
    "DAVIDSON", "HOPKINS", "MAY", "TERRY", "HERRERA", "WADE", "SOTO",
    "WALTERS", "CURTIS", "NEAL", "CALDWELL", "LOWE", "JENNINGS",
    "BARNETT", "GRAVES", "JIMENEZ", "HORTON", "SHELTON", "BARRETT",
    "OBRIEN", "CASTRO", "SUTTON", "GREGORY", "MCKINNEY", "LUCAS",
    "MILES", "CRAIG", "RODRIQUEZ", "CHAMBERS", "HOLT", "LAMBERT",
    "FLETCHER", "WATTS", "BATES", "HALE", "RHODES", "PENA", "BECK",
    "NEWMAN", "HAYNES", "MCDANIEL", "MENDEZ", "BUSH", "VAUGHN", "PARKS",
    "DAWSON", "SANTIAGO", "NORRIS", "HARDY", "LOVE", "STEELE", "CURRY",
    "POWERS", "SCHULTZ", "BARKER", "GUZMAN", "PAGE", "MUNOZ", "BALL",
    "KELLER", "CHANDLER", "WEBER", "LEONARD", "WALSH", "NORMAN", "STRONG",
    "LUNA", "OBRYAN", "TATE",
]

TEEN_FIRST_M = [
    "MICHAEL", "JAMES", "JOHN", "ROBERT", "MARK", "WILLIAM", "RICHARD",
    "JEFFREY", "SCOTT", "STEVEN", "KEVIN", "BRIAN", "TIMOTHY", "TODD",
    "GREGORY", "DANIEL", "ERIC", "RONALD", "KENNETH", "PAUL", "DOUGLAS",
    "GARY", "RANDY", "TERRY", "CRAIG", "KEITH", "BRAD", "DALE", "TONY",
    "CURTIS", "DUANE", "VERNON", "GLENN", "WAYNE", "ROGER", "BRUCE",
]
TEEN_FIRST_F = [
    "LISA", "MICHELLE", "KIMBERLY", "AMY", "ANGELA", "MELISSA", "TAMMY",
    "MARY", "TRACY", "JULIE", "KAREN", "LAURA", "CHRISTINE", "SUSAN",
    "DAWN", "STACEY", "SHANNON", "WENDY", "PATRICIA", "PAMELA", "DENISE",
    "CYNTHIA", "LORI", "SHERRY", "TERESA", "DIANE", "BRENDA", "SHARON",
    "DONNA", "CAROL", "SANDRA", "PEGGY", "RHONDA", "VICKIE", "JANET",
]

ADULT_FIRST_M = [
    "JOHN", "ROBERT", "WILLIAM", "RICHARD", "CHARLES", "DONALD", "GEORGE",
    "KENNETH", "EDWARD", "HENRY", "WALTER", "ARTHUR", "RALPH", "HAROLD",
    "FRANK", "RAYMOND", "EUGENE", "HOWARD", "ALBERT", "LEONARD", "STANLEY",
    "NORMAN", "ERNEST", "FRED", "HERBERT", "CLARENCE", "SAMUEL", "PHILIP",
]
ADULT_FIRST_F = [
    "MARY", "DOROTHY", "HELEN", "MARGARET", "RUTH", "VIRGINIA", "DORIS",
    "MILDRED", "FRANCES", "ELIZABETH", "EVELYN", "ANNE", "BETTY",
    "ELEANOR", "GLORIA", "MARTHA", "ROSE", "IRENE", "ALICE", "FLORENCE",
    "LOIS", "PHYLLIS", "NORMA", "JEAN", "MARION", "GRACE", "SHIRLEY",
]

TEACHER_TITLES = ["MR", "MRS", "MISS"]

# The surname pool is ordered by rough 1980-census frequency; draw with a
# gently decaying weight so a few hundred records actually contain their
# Smiths and Johnsons instead of a uniform spread.
SURNAME_WEIGHTS = [1.0 / (rank + 10) for rank in range(len(SURNAMES))]


def pick_surname(rng: random.Random) -> str:
    return rng.choices(SURNAMES, weights=SURNAME_WEIGHTS, k=1)[0]


def pad(s: str, width: int) -> str:
    if len(s) > width:
        raise ValueError(f"field overflow: {s!r} > {width}")
    return s.ljust(width)


# ---------------------------------------------------------------------------
# airline: flights.dat + passengers.dat
# ---------------------------------------------------------------------------

# The six flights the golden fixtures were written against, pinned verbatim
# (pair, orig, dest, key, disp, dep, arr, arrlen, seats).
PINNED_FLIGHTS = [
    ("JFKPAR", "JFK", "ORY", "PA002", "PA 002", "1900", "0810+1", 6, "F4 C6 Y9"),
    ("JFKPAR", "JFK", "ORY", "PA120", "PA 120", "2100", "1010+1", 6, "F2 C4 Y7"),
    ("JFKLHR", "JFK", "LHR", "PA100", "PA 100", "0800", "2000", 4, "F6 C8 Y9"),
    ("JFKLHR", "JFK", "LHR", "PA106", "PA 106", "1800", "0600+1", 6, "F4 C6 Y9"),
    ("LAXJFK", "LAX", "JFK", "PA400", "PA 400", "0700", "1520", 4, "F4 C6 Y9"),
    ("LAXJFK", "LAX", "JFK", "PA440", "PA 440", "1300", "2115", 4, "F2 C4 Y7"),
]

# 1983-plausible Pan Am city pairs: (orig, dest, block minutes, number range).
# Atlantic 1xx, Latin America 2xx, transcon 4xx, Berlin IGS 6xx, Pacific 8xx.
ROUTES = [
    ("ORY", "JFK", 8 * 60 + 15, (100, 199)),
    ("LHR", "JFK", 8 * 60, (100, 199)),
    ("JFK", "FRA", 7 * 60 + 30, (100, 199)),
    ("FRA", "JFK", 8 * 60 + 30, (100, 199)),
    ("JFK", "FCO", 8 * 60 + 30, (100, 199)),
    ("FCO", "JFK", 9 * 60 + 30, (100, 199)),
    ("IAD", "LHR", 7 * 60 + 20, (100, 199)),
    ("LHR", "IAD", 8 * 60 + 10, (100, 199)),
    ("MIA", "LHR", 8 * 60 + 40, (100, 199)),
    ("LHR", "MIA", 9 * 60 + 20, (100, 199)),
    ("JFK", "SJU", 3 * 60 + 45, (200, 299)),
    ("SJU", "JFK", 3 * 60 + 55, (200, 299)),
    ("JFK", "GIG", 9 * 60 + 30, (200, 299)),
    ("GIG", "JFK", 9 * 60 + 40, (200, 299)),
    ("JFK", "EZE", 10 * 60 + 50, (200, 299)),
    ("EZE", "JFK", 10 * 60 + 40, (200, 299)),
    ("JFK", "CCS", 4 * 60 + 40, (200, 299)),
    ("CCS", "JFK", 4 * 60 + 50, (200, 299)),
    ("MIA", "CCS", 3 * 60 + 5, (200, 299)),
    ("CCS", "MIA", 3 * 60 + 10, (200, 299)),
    ("MIA", "GUA", 2 * 60 + 35, (200, 299)),
    ("GUA", "MIA", 2 * 60 + 30, (200, 299)),
    ("MIA", "PTY", 2 * 60 + 55, (200, 299)),
    ("PTY", "MIA", 2 * 60 + 50, (200, 299)),
    ("JFK", "LAX", 6 * 60, (400, 499)),
    ("FRA", "TXL", 1 * 60 + 5, (600, 699)),
    ("TXL", "FRA", 1 * 60 + 5, (600, 699)),
    ("TXL", "MUC", 1 * 60 + 10, (600, 699)),
    ("MUC", "TXL", 1 * 60 + 10, (600, 699)),
    ("TXL", "HAM", 55, (600, 699)),
    ("HAM", "TXL", 55, (600, 699)),
    ("LAX", "HNL", 5 * 60 + 30, (800, 899)),
    ("HNL", "LAX", 5 * 60, (800, 899)),
    ("SFO", "HNL", 5 * 60 + 10, (800, 899)),
    ("HNL", "SFO", 4 * 60 + 45, (800, 899)),
    ("HNL", "NRT", 8 * 60 + 30, (800, 899)),
    ("NRT", "HNL", 7 * 60 + 30, (800, 899)),
    ("SFO", "NRT", 10 * 60 + 30, (800, 899)),
    ("NRT", "SFO", 9 * 60 + 10, (800, 899)),
    ("NRT", "HKG", 4 * 60 + 40, (800, 899)),
    ("HKG", "NRT", 4 * 60 + 10, (800, 899)),
    ("HNL", "SYD", 10 * 60, (800, 899)),
    ("SYD", "HNL", 9 * 60 + 20, (800, 899)),
    ("HNL", "GUM", 7 * 60 + 30, (800, 899)),
    ("GUM", "HNL", 7 * 60, (800, 899)),
]

DEP_SLOTS = ["0700", "0800", "0900", "1000", "1100", "1300",
             "1500", "1700", "1800", "1900", "2100", "2200"]


def gen_flights(rng: random.Random):
    flights = list(PINNED_FLIGHTS)
    used_keys = {f[3] for f in flights}
    for orig, dest, block, (lo, hi) in ROUTES:
        pair = orig + dest
        n = rng.randint(2, 4)
        deps = sorted(rng.sample(DEP_SLOTS, n))
        for dep in deps:
            while True:
                num = rng.randint(lo, hi)
                key = "PA%03d" % num
                if key not in used_keys:
                    used_keys.add(key)
                    break
            disp = "PA %03d" % num
            dep_min = int(dep[:2]) * 60 + int(dep[2:])
            arr_min = dep_min + block
            plus1 = arr_min >= 24 * 60
            arr_min %= 24 * 60
            arr = "%02d%02d" % (arr_min // 60, arr_min % 60)
            if plus1:
                arr, arrlen = arr + "+1", 6
            else:
                arrlen = 4
            seats = "F%d C%d Y%d" % (rng.randint(0, 8), rng.randint(0, 8),
                                     rng.randint(0, 9))
            flights.append((pair, orig, dest, key, disp, dep, arr, arrlen, seats))
    return flights


def gen_passengers(rng: random.Random, flights):
    keys = [f[3] for f in flights]
    names = set()
    passengers = []
    while len(passengers) < 341:
        if rng.random() < 0.55:
            first = rng.choice(ADULT_FIRST_M)
            title = rng.choice(["MR", "MR", "MR", "DR", "REV", "COL"])
        else:
            first = rng.choice(ADULT_FIRST_F)
            title = rng.choice(["MRS", "MRS", "MISS", "MISS", "DR"])
        surname = pick_surname(rng)
        name = f"{surname}/{first} {title}"
        if len(name) > 26 or name in names:
            continue
        names.add(name)
        key = rng.choice(keys)
        cls = rng.choice("YYYYYYYCCF")
        date = "%02d%s" % (rng.randint(1, 28), rng.choice(["MAY", "JUN"]))
        passengers.append((name, key, cls, date))
    # One easter-egg professor, apparently not dead after all, London-bound.
    passengers.append(("FALKEN/STEPHEN PROF", "PA100", "F", "18JUN"))
    passengers.sort(key=lambda p: p[0])
    return passengers


# ---------------------------------------------------------------------------
# school district: students / courses / schedule / grades
# ---------------------------------------------------------------------------

# The two canonical students, verbatim, with their exact course rows in the
# exact order the fixtures display them. Ids 1 and 2, whatever their
# alphabetical position.
PINNED_STUDENTS = [
    (1, "LIGHTMAN, DAVID L.", "11",
     [("BIOLOGY 2", "F"), ("ENGLISH 11", "D"), ("GEOMETRY", "C"),
      ("COMPUTER LAB", "A")]),
    (2, "MACK, JENNIFER K.", "11",
     [("BIOLOGY 2", "F"), ("ENGLISH 11", "B"), ("ALGEBRA 2", "C"),
      ("PHYS ED", "A")]),
]

ENGLISH = {"9": "ENGLISH 9", "10": "ENGLISH 10", "11": "ENGLISH 11",
           "12": "ENGLISH 12"}
MATH = {"9": ["ALGEBRA 1", "GEOMETRY"], "10": ["GEOMETRY", "ALGEBRA 2"],
        "11": ["ALGEBRA 2", "TRIGONOMETRY"],
        "12": ["TRIGONOMETRY", "CALCULUS"]}
SCIENCE = {"9": ["EARTH SCIENCE", "GEN SCIENCE"], "10": ["BIOLOGY 1"],
           "11": ["BIOLOGY 2", "CHEMISTRY"], "12": ["PHYSICS", "CHEMISTRY"]}
SOCIAL = {"9": ["CIVICS"], "10": ["WORLD HISTORY"], "11": ["US HISTORY"],
          "12": ["ECONOMICS"]}
ELECTIVES = ["COMPUTER LAB", "TYPING 1", "WOOD SHOP", "AUTO SHOP",
             "METAL SHOP", "HOME EC", "ART 1", "BAND", "CHOIR", "DRAMA",
             "JOURNALISM", "SPANISH 1", "SPANISH 2", "FRENCH 1", "FRENCH 2",
             "GERMAN 1", "LATIN 1", "DRIVER ED"]

GRADE_LETTERS = "AABBBCCCDF"  # weighted draw


def gen_students(rng: random.Random):
    """318 generated students + the 2 pinned, sorted by name; ids 1 and 2 are
    pinned, the rest numbered 3.. in alphabetical order."""
    names = {s[1] for s in PINNED_STUDENTS}
    generated = []
    while len(generated) < 318:
        if rng.random() < 0.5:
            first = rng.choice(TEEN_FIRST_M)
        else:
            first = rng.choice(TEEN_FIRST_F)
        surname = pick_surname(rng)
        initial = rng.choice("ABCDEFGHJKLMNPRSTW")
        name = f"{surname}, {first} {initial}."
        if len(name) > 30 or name in names:
            continue
        names.add(name)
        grade = rng.choice(["9", "10", "11", "12"])
        generated.append((name, grade))

    generated.sort(key=lambda s: s[0])
    next_id = 3
    students = []  # (id, name, grade, [(course, letter), ...])
    for name, grade in generated:
        courses = [ENGLISH[grade], rng.choice(MATH[grade]),
                   rng.choice(SCIENCE[grade]), rng.choice(SOCIAL[grade]),
                   "PHYS ED", rng.choice(ELECTIVES)]
        # a stray double elective for some students
        if rng.random() < 0.25:
            extra = rng.choice(ELECTIVES)
            if extra not in courses:
                courses.append(extra)
        rows = [(c, rng.choice(GRADE_LETTERS)) for c in courses]
        students.append((next_id, name, grade, rows))
        next_id += 1

    roster = students + [(i, n, g, r) for (i, n, g, r) in PINNED_STUDENTS]
    roster.sort(key=lambda s: s[1])  # file order is alphabetical
    return roster


def gen_catalog(rng: random.Random, roster):
    seen = []
    for _, _, _, rows in roster:
        for course, _ in rows:
            if course not in seen:
                seen.append(course)
    seen.sort()
    catalog = []
    used = set()
    for course in seen:
        room = "RM %d" % rng.randint(101, 318)
        while True:
            teacher = "%s %s" % (rng.choice(TEACHER_TITLES),
                                 rng.choice(SURNAMES))
            if len(teacher) <= 12 and teacher not in used:
                used.add(teacher)
                break
        catalog.append((course, room, teacher))
    return catalog


MONTHS = ["SEP", "OCT", "NOV", "DEC", "JAN", "FEB", "MAR", "APR", "MAY", "JUN"]

# Absence rises through the winter and falls off in June, the way a real
# register does. These are relative weights on the mean days missed per month;
# the exact shape is not load-bearing, but determinism and a total that makes
# ADA visibly differ from ADM both are.
MONTH_WEIGHT = {
    "SEP": 0.6, "OCT": 0.9, "NOV": 1.2, "DEC": 1.6, "JAN": 1.8,
    "FEB": 1.5, "MAR": 1.1, "APR": 0.9, "MAY": 0.7, "JUN": 0.5,
}

# A pupil misses at most three school weeks in a single month. This is a
# plausibility ceiling on the exponential's tail, not a calendar fact, and
# it is the SECOND of the two clamps below - see MONTH_DAYS.
MAX_DAYS_ABSENT = 15

# Instructional days per month, transcribed from
# systems/school-ada/data/calend.dat (HIGH; 180 days in the year). The
# other clamp, answering a different question: MAX_DAYS_ABSENT says how
# much absence is believable, this says how much the month physically held.
# Both belong. DEC keeps 14 days, so MAX_DAYS_ABSENT alone once let a row
# claim 15 days absent in a 14-day month; MONTH_DAYS alone would raise the
# ceiling to 22 in the eight months longer than three weeks, which is the
# same implausibility from the other side.
#
# The duplication of calend.dat's figures is deliberate: modules here may
# not share code libraries, so spec-level duplication is the sanctioned way
# to know another module's data (CONTRIBUTING.md, "federation"). Keep the
# two in step by hand.
MONTH_DAYS = {
    "SEP": 20, "OCT": 22, "NOV": 18, "DEC": 14, "JAN": 19,
    "FEB": 18, "MAR": 21, "APR": 16, "MAY": 21, "JUN": 11,
}


def gen_absences(rng: random.Random, ids):
    """One row per student per month: the monthly attendance register the
    office keyed from teachers' daily registers.

    Returns [(student_id, month, days_absent)], ordered by id then by
    calendar month. ADAR11 sums the third field and never looks at a single
    pupil's row — but the keyed source is what a 1983 office actually held,
    and spec section 6 says the generated artifact is the source, not a
    summary the batch tier should be computing itself.

    Sorted to ascending numeric id here, deliberately not left in the
    caller's roster order: students.dat's file order is alphabetical by
    name (gen_students sorts on the name field), which is not the id
    order the register is keyed in.

    A row is clamped twice, by MAX_DAYS_ABSENT and by its own month's
    instructional days (MONTH_DAYS). Two ceilings, two questions: no pupil
    misses more than three school weeks in a month, and no pupil misses
    more days than the month actually held. A clerk could not have keyed
    either, and this file's whole justification is that it is the artifact
    somebody actually keyed.
    """
    rows = []
    for sid in sorted(ids):
        # A pupil's own tendency to be absent, steady across the year.
        habit = rng.choice([0.3, 0.5, 0.8, 1.0, 1.4, 2.2])
        for month in MONTHS:
            mean = habit * MONTH_WEIGHT[month]
            days = min(int(rng.expovariate(1.0 / mean)),
                       MAX_DAYS_ABSENT, MONTH_DAYS[month])
            rows.append((sid, month, days))
    return rows


# ---------------------------------------------------------------------------


def main():
    rng = random.Random(SEED)

    flights = gen_flights(rng)
    passengers = gen_passengers(rng, flights)
    roster = gen_students(rng)
    catalog = gen_catalog(rng, roster)

    airline = ROOT / "systems" / "airline" / "data"
    school = ROOT / "systems" / "school" / "data"
    schooldb = ROOT / "systems" / "school-db" / "data"
    for d in (airline, school, schooldb):
        d.mkdir(parents=True, exist_ok=True)

    with open(airline / "flights.dat", "w") as f:
        for pair, orig, dest, key, disp, dep, arr, arrlen, seats in flights:
            f.write("%s %s %s %s %s %s %s %d %s\n" % (
                pad(pair, 6), pad(orig, 3), pad(dest, 3), pad(key, 5),
                pad(disp, 6), pad(dep, 4), pad(arr, 6), arrlen,
                pad(seats, 8)))

    with open(airline / "passengers.dat", "w") as f:
        for name, key, cls, date in passengers:
            f.write("%s %s %s %s\n" % (pad(name, 26), pad(key, 5), cls,
                                       pad(date, 5)))

    with open(school / "students.dat", "w") as f:
        for sid, name, grade, _ in roster:
            f.write("%04d %s %s\n" % (sid, pad(name, 30), pad(grade, 2)))

    with open(school / "courses.dat", "w") as f:
        for course, room, teacher in catalog:
            f.write("%s %s %s\n" % (pad(course, 14), pad(room, 6),
                                    pad(teacher, 12)))

    with open(school / "schedule.dat", "w") as f:
        for sid, _, _, rows in roster:
            for course, _ in rows:
                f.write("%04d %s\n" % (sid, pad(course, 14)))

    with open(schooldb / "grades.dat", "w") as f:
        for sid, _, _, rows in roster:
            for course, letter in rows:
                f.write("%04d %s %s\n" % (sid, pad(course, 14), letter))

    print("flights           %4d" % len(flights))
    print("passengers        %4d" % len(passengers))
    print("students          %4d" % len(roster))
    print("courses (catalog) %4d" % len(catalog))
    print("schedule rows     %4d" % sum(len(r[3]) for r in roster))
    print("grade rows        %4d" % sum(len(r[3]) for r in roster))

    # Called last: every file above is drawn from the one shared seeded PRNG
    # in sequence, so a draw inserted anywhere but the end would shift every
    # subsequent draw and rewrite unrelated committed data (see module
    # docstring and real-wopr#174).
    absences = gen_absences(rng, [sid for sid, _, _, _ in roster])

    schoolada = ROOT / "systems" / "school-ada" / "data"
    schoolada.mkdir(parents=True, exist_ok=True)
    with open(schoolada / "absenc.dat", "w") as f:
        for sid, month, days in absences:
            f.write("%04d %s %2d\n" % (sid, month, days))

    print("absence rows      %4d" % len(absences))


if __name__ == "__main__":
    main()
