#!/usr/bin/env bash
# Regression check: a catlog.dat row flagged "Y" (readable) whose file is
# not on disk must make TYPE answer "?Can't find file or account", not
# abort bwBASIC (see login.bas 4320-4330).
#
# This can't be a golden `.in`/`.out` fixture: the shipped data/catlog.dat
# may never contain a row that fails its own honesty rule (every entry
# resolves to a real file), so there is nothing legitimate for a diff
# fixture to point at. Instead this builds a disposable copy of the
# program with one deliberately-broken row — the same way the missing-file
# crash was found and verified in review — probes it there, and throws the
# copy away.
set -uo pipefail
cd "$(dirname "$0")/.."   # systems/school-mon
SRC="$(pwd)"

command -v bwbasic >/dev/null 2>&1 || {
  echo "verify-missing-file-refusal: bwbasic not found on PATH" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$SRC/login.bas" "$tmp/"
mkdir -p "$tmp/data"
cp "$SRC"/data/*.dat "$SRC"/data/*.doc "$SRC"/data/*.txt "$SRC"/data/*.cmd "$tmp/data/" 2>/dev/null

# A row shaped exactly like a real one, flagged readable, whose file is
# deliberately never created — the shape a Task-2-style row addition could
# ship by mistake. Width matches Task 4's widened EXEC-TARGET field (39
# chars total; see login.bas's 8642 comment and verify-catalog.py).
printf 'GHOST.DOC    [1,2]   001 0 -          Y\n' >> "$tmp/data/catlog.dat"

raw="$(cd "$tmp" && bwbasic "login.bas" 2>/dev/null <<'EOF'
SYSTEM/1 school-mon INPUT
STATE 3
PHASE READY
ACCT [1,1]
TRIES 0
INPUT TYPE GHOST.DOC
END
EOF
)"
rc=$?
out="$(printf '%s\n' "$raw" | sed -n '/^SYSTEM\/1 /,/^END$/p')"

if [ $rc -ne 0 ]; then
  echo "FAIL verify-missing-file-refusal: bwbasic exited $rc (expected 0)" >&2
  exit 1
fi
if [ -z "$out" ]; then
  echo "FAIL verify-missing-file-refusal: no SYSTEM/1 response (a runtime abort - the defect this guards against)" >&2
  echo "raw bwbasic output was:" >&2
  printf '%s\n' "$raw" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "?Can't find file or account"; then
  echo "FAIL verify-missing-file-refusal: expected the in-character refusal, got:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "verify-missing-file-refusal: OK (in-character refusal, exit 0)"
