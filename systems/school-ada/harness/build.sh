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
printf '%s\n' "$out"
case "$out" in
  *"PROTOCOL ERROR"*) exit 1 ;;
esac
exit 0
WRAP
chmod +x bin/school-ada
echo "built systems/school-ada -> harness/bin/school-ada"
