#!/usr/bin/env bash
# Build the school system. Source is ../school.bas; BASIC is interpreted, so
# bin/school is a wrapper that runs it under bwBASIC, strips the signon banner
# and prompt, and exits non-zero on a PROTOCOL ERROR (so *error* fixtures fail
# as the golden runner expects). Requires the Bywater BASIC interpreter.
set -euo pipefail
cd "$(dirname "$0")"
command -v bwbasic >/dev/null 2>&1 || { echo "build.sh: bwbasic not found on PATH" >&2; exit 1; }
mkdir -p bin
cat > bin/school <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
src="$(cd "$(dirname "$0")/../.." && pwd)/school.bas"
out="$(bwbasic "$src" 2>/dev/null | sed -n '/^SYSTEM\/1 /,/^END$/p')"
printf '%s\n' "$out"
case "$out" in
  *"PROTOCOL ERROR"*) exit 1 ;;
esac
exit 0
WRAP
chmod +x bin/school
echo "built systems/school -> harness/bin/school"
