#!/usr/bin/env bash
# Regression check for review Finding 4: SUBMIT must resolve the job
# file's RUN target through the same 8100 resolver 4900 (the batch CALL)
# uses, and refuse right away if it will not resolve - not accept the
# job and let it fail two turns later when 4900 finally tries the CALL.
#
# This can't be a golden `.in`/`.out` fixture: it needs a .CMD file on
# disk naming a program the catalog cannot resolve to a CALL-only bus
# peer, and the shipped catalog/data should never itself contain such a
# row (that would be exactly the honesty violation verify-catalog.sh
# guards against). So, like verify-missing-file-refusal.sh beside this
# script, this builds a disposable copy of the program with one
# deliberately-bad job file and probes it there.
set -uo pipefail
cd "$(dirname "$0")/.."   # systems/school-mon
SRC="$(pwd)"

command -v bwbasic >/dev/null 2>&1 || {
  echo "verify-submit-resolver: bwbasic not found on PATH" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$SRC/login.bas" "$tmp/"
mkdir -p "$tmp/data"
cp "$SRC"/data/*.dat "$SRC"/data/*.doc "$SRC"/data/*.txt "$SRC"/data/*.cmd "$tmp/data/" 2>/dev/null

# A row shaped exactly like ADARUN.CMD's real one (readable, not itself
# an EXEC/CALL target), naming a job file whose RUN line points at a
# program the catalog cannot resolve at all - the shape a Task-4-style
# job addition could ship by mistake. Width matches catlog.dat's 41-char
# rows (see verify-catalog.sh).
tail="$(grep '^ADARUN' "$SRC/data/catlog.dat" | cut -c13-)"
printf 'BADJOB.CMD  %s\n' "$tail" >> "$tmp/data/catlog.dat"
printf 'RUN NOSUCH\n' > "$tmp/data/badjob.cmd"

raw="$(cd "$tmp" && bwbasic "login.bas" 2>/dev/null <<'EOF'
SYSTEM/1 school-mon INPUT
STATE 8
PHASE READY
ACCT [20,20]
TRIES 0
NEXTJOB 412
JOB 0
STEP 0
PROG
REPORT
INPUT SUBMIT BADJOB
END
EOF
)"
rc=$?
out="$(printf '%s\n' "$raw" | sed -n '/^SYSTEM\/1 /,/^END$/p')"

if [ $rc -ne 0 ]; then
  echo "FAIL verify-submit-resolver: bwbasic exited $rc (expected 0 - an in-character refusal, not a crash)" >&2
  exit 1
fi
if [ -z "$out" ]; then
  echo "FAIL verify-submit-resolver: no SYSTEM/1 response (a runtime abort - not what this checks)" >&2
  printf 'raw bwbasic output was:\n%s\n' "$raw" >&2
  exit 1
fi
if printf '%s' "$out" | grep -q "QUEUED"; then
  echo "FAIL verify-submit-resolver: SUBMIT accepted a job whose program cannot resolve (review Finding 4) - got:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi
if ! printf '%s' "$out" | grep -q "?Can't find file or account"; then
  echo "FAIL verify-submit-resolver: expected the in-character refusal, got:" >&2
  printf '%s\n' "$out" >&2
  exit 1
fi

echo "verify-submit-resolver: OK (SUBMIT refuses a job file naming an unresolvable program, at submit time)"
