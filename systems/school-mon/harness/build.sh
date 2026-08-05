#!/usr/bin/env bash
# Build the school-mon system. Source is ../login.bas; BASIC is interpreted, so
# bin/school-mon is a wrapper that runs it under bwBASIC, strips the signon banner
# and prompt, and exits non-zero on a PROTOCOL ERROR or on a bwBASIC runtime
# abort (empty output) — so *error* fixtures fail as the golden runner expects,
# and a crash never masquerades as a clean empty response. Requires the
# Bywater BASIC interpreter.
set -euo pipefail
cd "$(dirname "$0")"
command -v bwbasic >/dev/null 2>&1 || { echo "build.sh: bwbasic not found on PATH" >&2; exit 1; }
mkdir -p bin
cat > bin/school-mon <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
# chdir to the program's folder so the BASIC's relative OPEN of its
# data/*.dat files resolves no matter where the host spawned us from.
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out="$(bwbasic "login.bas" 2>/dev/null | sed -n '/^SYSTEM\/1 /,/^END$/p')"
# A bwBASIC runtime abort (e.g. "Line number N not found") prints nothing
# matching the SYSTEM/1 range and exits 0 on its own — silently turning a
# crash into an empty, well-formed-looking frame. Treat empty output as a
# failure too, not just an explicit PROTOCOL ERROR.
#
# That guard alone is not enough (review Finding 1): every abort inside
# the range the sed above captures happens *after* some PRINT has already
# run, so `out` is non-empty even when bwBASIC died mid-response — the sed
# range has an open start (`/^SYSTEM\/1 /`) but no matching `/^END$/` ever
# arrives, so it just prints everything through EOF: a truncated,
# headerless-body frame that used to slip past `[ -z "$out" ]` with exit
# 0. A well-formed response always ends in "END" (see 7000/7900's own
# tails); require that too.
if [ -z "$out" ]; then
  echo "school-mon: bwbasic produced no SYSTEM/1 response (a runtime abort?)" >&2
  exit 1
fi
case "$out" in
  *$'\n'END) ;;
  END) ;;
  *)
    echo "school-mon: bwbasic response did not end in END (a runtime abort mid-response?)" >&2
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
chmod +x bin/school-mon
echo "built systems/school-mon -> harness/bin/school-mon"

# Catalog honesty gate: every catlog.dat row flagged readable ("Y") must
# name a real file, and a row that somehow isn't must be refused
# in-character (not crash bwBASIC) — see verify-catalog.sh and
# verify-missing-file-refusal.sh beside this script for why these aren't
# golden fixtures. Both are shell, not Python: this script runs inside
# emulator/node/Dockerfile's "programs" stage, which has no python3.
./verify-catalog.sh
./verify-missing-file-refusal.sh
./verify-crash-guard.sh
