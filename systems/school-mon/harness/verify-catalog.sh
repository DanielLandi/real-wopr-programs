#!/usr/bin/env bash
# Assert every catlog.dat row flagged readable ("Y") names a real file
# under data/.
#
# This is the loader's own honesty rule (docs: every disk catalogue entry
# resolves to a real file), checked from outside the running program
# instead of only being trusted at runtime. It mirrors the exact byte
# offsets login.bas's 8600 loader uses: NAME 1-12, EXEC-TARGET 28-37
# (widened from 28-35 in Task 4, to fit the "school-ada" peer id), KIND at
# 39 ("E" an EXEC target, "C" a CALL-only bus peer, "-" neither - see
# login.bas's 8620 comment and 4526/4930's guards), READ-FLAG at 41 (was
# 37, then 39). A row that fails this check is exactly the shape TYPE's
# 4300 handler must refuse in-character rather than crash on (see
# login.bas 4320-4330 and verify-missing-file-refusal.sh beside this
# script).
#
# Not a golden fixture: the shipped catlog.dat may never contain a row
# that fails this check (that would itself violate the honesty rule), so
# there is nothing for a `.in`/`.out` pair to diff against. This runs as a
# plain build-time gate instead, the same way tools/gen-dial-directory.py
# --check gates pack.json elsewhere in this pack.
#
# Shell/bash, not Python: the Dockerfile's "programs" build stage
# (emulator/node/Dockerfile) carries only the period toolchains -
# gfortran, sbcl, gnucobol, bwbasic, cc65, gcc - and no python3, so the
# original Python version of this check broke every image build
# (`tools/build.sh && tools/test.sh` dies at this script, silently, before
# the "programs" stage even finishes). harness/build.sh is already bash,
# so this is also the more idiomatic home for it.
set -euo pipefail
cd "$(dirname "$0")/.."   # systems/school-mon
root="$(pwd)"
catalog="$root/data/catlog.dat"

fail=0
lineno=0
while IFS= read -r line || [ -n "$line" ]; do
  lineno=$((lineno + 1))
  name="${line:0:12}"
  name="${name%"${name##*[![:space:]]}"}"   # trim trailing spaces
  flag="${line:40:1}"
  [ "$flag" = "Y" ] || continue
  lname="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  path="$root/data/$lname"
  if [ ! -f "$path" ]; then
    echo "$catalog:$lineno: $name is flagged Y (readable) but data/$lname does not exist" >&2
    fail=1
  fi
done < "$catalog"

if [ "$fail" -ne 0 ]; then
  echo "catlog.dat honesty check FAILED" >&2
  exit 1
fi
echo "catlog.dat honesty check: OK (every Y row has a real file)"
