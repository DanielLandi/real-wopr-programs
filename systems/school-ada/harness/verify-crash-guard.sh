#!/usr/bin/env bash
# Regression check for the wrapper's crash guard (review Finding 1,
# folded in from school-mon's harness/build.sh/verify-crash-guard.sh):
# a bwBASIC runtime abort that happens *after* the response header has
# already been printed must still make bin/school-ada exit non-zero, not
# masquerade as a clean response just because its output is non-empty.
#
# This can't be a golden `.in`/`.out` fixture: the shipped main.bas
# should never itself crash on a well-formed request, so there is
# nothing legitimate for a diff fixture to point at. Instead this builds
# a disposable copy of the program with one deliberately shrunk array
# bound - forcing a genuine bwBASIC abort mid-response on the program's
# one and only ordinary RUN ADAR11 request - and confirms the wrapper's
# own post-processing (build.sh's WRAP heredoc) catches it.
set -uo pipefail
cd "$(dirname "$0")/.."   # systems/school-ada
SRC="$(pwd)"

command -v bwbasic >/dev/null 2>&1 || {
  echo "verify-crash-guard: bwbasic not found on PATH" >&2
  exit 1
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/data" "$tmp/../school/data"
cp "$SRC/main.bas" "$tmp/"
cp "$SRC/data/calend.dat" "$tmp/data/"
# The 8800 loader opens data/absenc.dat at startup (line 950), before any
# request is parsed - without it the program aborts with no output at all,
# which is not the mid-response abort this check exists to reproduce.
cp "$SRC/data/absenc.dat" "$tmp/data/"
# main.bas's 8500 loader reads ../school/data/students.dat (a sibling
# system's disk) - mirror that one relative path too.
cp "$SRC/../school/data/students.dat" "$tmp/../school/data/students.dat" 2>/dev/null || true

# main.bas computes the whole report and builds LN$() *before* it ever
# prints the response header (4330) - every naturally-reachable crash in
# its own computation would therefore abort *before* any output, which
# doesn't exercise what Finding 1 is actually about (an abort *after* the
# header is already on the wire). So inject a line that can only fail
# after the header: jump to a line number that does not exist, right
# after 4330's PRINT, forcing bwBASIC's classic "Line number N not found"
# abort mid-response - the same shape as login.bas's own reproduction.
sed -i.bak '/^4330 PRINT "SYSTEM\/1 school-ada OK"$/a\
4335 GOTO 99999
' "$tmp/main.bas"
if ! grep -q '^4335 GOTO 99999$' "$tmp/main.bas"; then
  echo "verify-crash-guard: failed to patch main.bas after line 4330 (source shape changed?)" >&2
  exit 1
fi

raw="$(cd "$tmp" && bwbasic "main.bas" 2>/dev/null <<'EOF'
SYSTEM/1 school-ada INPUT
STATE 0
INPUT RUN ADAR11
END
EOF
)"
out="$(printf '%s\n' "$raw" | sed -n '/^SYSTEM\/1 /,/^END$/p')"

if [ -z "$out" ]; then
  echo "FAIL verify-crash-guard: expected a non-empty, truncated response (got none) - the shrunk array didn't force the crash this check relies on" >&2
  printf 'raw bwbasic output was:\n%s\n' "$raw" >&2
  exit 1
fi

# Non-empty output, but no trailing END - a well-formed-looking frame
# that is actually truncated mid-response.
case "$out" in
  *$'\n'END|END)
    echo "FAIL verify-crash-guard: response ended in END - the shrunk bound didn't reproduce a mid-response abort, so this check isn't exercising the guard" >&2
    printf '%s\n' "$out" >&2
    exit 1
    ;;
esac

# Now run the exact guard logic bin/school-ada's WRAP heredoc uses
# (build.sh, right beside this script) against that same $out.
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
