#!/usr/bin/env bash
# Build every program in the pack by running each program's harness/build.sh.
# Each program is self-contained; a missing toolchain fails only that program.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
shopt -s nullglob
for h in games/*/harness systems/*/harness joshua/harness; do
  [ -x "$h/build.sh" ] || continue
  if ! "$h/build.sh"; then echo "BUILD FAILED: $h/build.sh" >&2; fail=1; fi
done
exit $fail
