#!/usr/bin/env bash
# Build the school system. Source is ../records.bas; BASIC is interpreted, so
# bin/school is a wrapper that runs it under bwBASIC, strips the signon banner
# and prompt, and exits non-zero on a PROTOCOL ERROR or on a bwBASIC runtime
# abort (empty output) — so *error* fixtures fail as the golden runner expects,
# and a crash never masquerades as a clean empty response. Requires the
# Bywater BASIC interpreter.
set -euo pipefail
cd "$(dirname "$0")"
command -v bwbasic >/dev/null 2>&1 || { echo "build.sh: bwbasic not found on PATH" >&2; exit 1; }
mkdir -p bin
cat > bin/school <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
# chdir to the program's folder so the BASIC's relative OPEN of its
# data/*.dat files resolves no matter where the host spawned us from.
cd "$(cd "$(dirname "$0")/../.." && pwd)"
out="$(bwbasic "records.bas" 2>/dev/null | sed -n '/^SYSTEM\/1 /,/^END$/p')"
# A bwBASIC runtime abort (e.g. "Line number N not found") prints nothing
# matching the SYSTEM/1 range and exits 0 on its own — silently turning a
# crash into an empty, well-formed-looking frame. Treat empty output as a
# failure too, not just an explicit PROTOCOL ERROR.
if [ -z "$out" ]; then
  echo "school: bwbasic produced no SYSTEM/1 response (a runtime abort?)" >&2
  exit 1
fi
printf '%s\n' "$out"
case "$out" in
  *"PROTOCOL ERROR"*) exit 1 ;;
esac
exit 0
WRAP
chmod +x bin/school
echo "built systems/school -> harness/bin/school"
