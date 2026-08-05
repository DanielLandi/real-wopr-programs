#!/usr/bin/env python3
"""Assert every catlog.dat row flagged readable ("Y") names a real file
under data/.

This is the loader's own honesty rule (docs: every disk catalogue entry
resolves to a real file), checked from outside the running program instead
of only being trusted at runtime. It mirrors the exact byte offsets
login.bas's 8600 loader uses: NAME 1-12, EXEC-TARGET 28-35, READ-FLAG at
37. A row that fails this check is exactly the shape TYPE's 4300 handler
must now refuse in-character rather than crash on (see login.bas
4320-4330 and verify-missing-file-refusal.sh beside this script).

Not a golden fixture: the shipped catlog.dat may never contain a row that
fails this check (that would itself violate the honesty rule), so there is
nothing for a `.in`/`.out` pair to diff against. This runs as a plain
build-time gate instead, the same way tools/gen-dial-directory.py --check
gates pack.json elsewhere in this pack.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)  # systems/school-mon
CATALOG = os.path.join(ROOT, "data", "catlog.dat")


def main() -> int:
    problems = []
    with open(CATALOG) as f:
        for lineno, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            name = line[0:12].rstrip()
            flag = line[36:37] if len(line) > 36 else ""
            if flag != "Y":
                continue
            path = os.path.join(ROOT, "data", name.lower())
            if not os.path.isfile(path):
                problems.append(
                    f"{CATALOG}:{lineno}: {name} is flagged Y (readable) "
                    f"but {os.path.relpath(path, ROOT)} does not exist"
                )
    if problems:
        print("catlog.dat honesty check FAILED:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1
    print("catlog.dat honesty check: OK (every Y row has a real file)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
