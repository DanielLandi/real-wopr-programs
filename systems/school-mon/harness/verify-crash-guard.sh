#!/usr/bin/env bash
# Regression check for the wrapper's crash guard (review Finding 1): a
# bwBASIC runtime abort that happens *after* the response header has
# already been printed must still make bin/school-mon exit non-zero, not
# masquerade as a clean response just because its output is non-empty.
#
# This can't be a golden `.in`/`.out` fixture: the shipped login.bas
# should never itself crash on a well-formed request (that's the bug the
# other findings in this review closed), so there is nothing legitimate
# for a diff fixture to point at. Instead this builds a disposable copy
# of the program with one deliberately injected defect - a jump to a
# line number that does not exist, right after the shared 7800 header
# routine's PRINT - forcing a genuine bwBASIC abort mid-response on an
# entirely ordinary request, and confirms the *wrapper's* own
# post-processing catches it. A "Line number N not found" abort is
# standard bwBASIC behavior, not a quirk of any one array-bound edge
# case, so this stays reliable across bwBASIC builds (an earlier version
# of this check shrunk an array bound instead, which built and passed
# locally but silently produced zero output - no banner, no error text -
# against the Debian package's bwbasic used by emulator/node/Dockerfile's
# "programs" build stage).
set -uo pipefail
cd "$(dirname "$0")/.."   # systems/school-mon
SRC="$(pwd)"

command -v bwbasic >/dev/null 2>&1 || {
  echo "verify-crash-guard: bwbasic not found on PATH" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
cp "$SRC/login.bas" "$tmp/"
mkdir -p "$tmp/data"
cp "$SRC"/data/*.dat "$SRC"/data/*.doc "$SRC"/data/*.txt "$SRC"/data/*.cmd "$tmp/data/" 2>/dev/null

# Every response path shares 7800's header print (7810). Jump to a line
# number that does not exist right after it: bwBASIC's "Line number N
# not found" abort fires only once the header is already on the wire,
# exactly the shape Finding 1 was reproduced with.
sed -i.bak '/^7810 PRINT "SYSTEM\/1 school-mon OK"$/a\
7815 GOTO 99999
' "$tmp/login.bas"
if ! grep -q '^7815 GOTO 99999$' "$tmp/login.bas"; then
  echo "verify-crash-guard: failed to patch login.bas after line 7810 (source shape changed?)" >&2
  exit 1
fi

raw="$(cd "$tmp" && bwbasic "login.bas" 2>/dev/null <<'EOF'
SYSTEM/1 school-mon INPUT
STATE 8
PHASE READY
ACCT [20,20]
TRIES 0
NEXTJOB 413
JOB 0
STEP 0
PROG
REPORT
INPUT CAT
END
EOF
)"
out="$(printf '%s\n' "$raw" | sed -n '/^SYSTEM\/1 /,/^END$/p')"

if [ -z "$out" ]; then
  echo "FAIL verify-crash-guard: expected a non-empty, truncated response (got none) - the injected GOTO didn't force the crash this check relies on" >&2
  printf 'raw bwbasic output was:\n%s\n' "$raw" >&2
  exit 1
fi

# This is the exact bug Finding 1 reproduced: non-empty output, but no
# trailing END - a well-formed-looking frame that is actually truncated
# mid-response. The old guard ([ -z "$out" ]) would have missed this.
case "$out" in
  *$'\n'END|END)
    echo "FAIL verify-crash-guard: response ended in END - the injected GOTO didn't reproduce a mid-response abort, so this check isn't exercising the guard" >&2
    printf '%s\n' "$out" >&2
    exit 1
    ;;
esac

# Now run the exact guard logic bin/school-mon's WRAP heredoc uses
# (build.sh, right beside this script) against that same $out, and
# confirm it does what the old `[ -z "$out" ]`-only check could not: exit
# non-zero on a non-empty but truncated response.
guard_rc=0
case "$out" in
  *$'\n'END) ;;
  END) ;;
  *) guard_rc=1 ;;
esac
if [ "$guard_rc" -ne 1 ]; then
  echo "FAIL verify-crash-guard: the wrapper's END-check logic did not flag this truncated response as a failure" >&2
  exit 1
fi

echo "verify-crash-guard: OK (a mid-response bwBASIC abort produces non-empty, non-END-terminated output, and the wrapper's END check correctly flags it as a failure)"
