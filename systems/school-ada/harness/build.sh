#!/usr/bin/env bash
# Build the state ADA claim (ADAR11). Source is ../main.bas; BASIC is
# interpreted, so bin/school-ada is a wrapper that runs it under bwBASIC,
# strips bwBASIC's own banner noise, and exits non-zero on a PROTOCOL ERROR
# (so the *error* fixture fails as the golden runner expects). Requires the
# Bywater BASIC interpreter.
set -euo pipefail
cd "$(dirname "$0")"
command -v bwbasic >/dev/null 2>&1 || { echo "build.sh: bwbasic not found on PATH" >&2; exit 1; }
mkdir -p bin
cat > bin/school-ada <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
# chdir to the program's folder so the BASIC's relative OPEN of data/calend.dat
# and ../school/data/students.dat resolves no matter where the host spawned
# us from.
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out="$(bwbasic "main.bas" 2>/dev/null | sed -n '/^SYSTEM\/1 /,/^END$/p')"
# A bwBASIC runtime abort prints nothing matching the SYSTEM/1 range and
# exits 0 on its own, and even when it prints a partial response first
# (the sed range above has an open start but no matching /^END$/ to close
# on), that partial output still looks well-formed enough to slip past an
# empty-output check. Require the response to actually end in "END" (see
# school-mon's harness/build.sh, review Finding 1, folded in here).
if [ -z "$out" ]; then
  echo "school-ada: bwbasic produced no SYSTEM/1 response (a runtime abort?)" >&2
  exit 1
fi
case "$out" in
  *$'\n'END) ;;
  END) ;;
  *)
    echo "school-ada: bwbasic response did not end in END (a runtime abort mid-response?)" >&2
    printf '%s\n' "$out" >&2
    exit 1
    ;;
esac
printf '%s\n' "$out"
case "$out" in
  *"PROTOCOL ERROR"*) exit 1 ;;
esac
exit 0
WRAP
chmod +x bin/school-ada
echo "built systems/school-ada -> harness/bin/school-ada"

# Crash guard gate: a bwBASIC abort mid-response must not exit 0 (review
# Finding 1, folded in here) - see verify-crash-guard.sh beside this
# script for why this isn't a golden fixture.
./verify-crash-guard.sh
