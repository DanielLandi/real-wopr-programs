#!/usr/bin/env bash
# Build every program in the pack by running each program's harness/build.sh.
# Each program is self-contained; a missing toolchain fails only that program.
#
# Which directories hold programs is read off pack.json (tools/categories.sh),
# not listed here. Within a category, a harness may sit at any depth the pack
# contract uses: <cat>/harness (joshua, wopr), <cat>/<id>/harness (games,
# systems), <cat>/<id>/<interpretation>/harness (tictactoe). Bounded to the
# declared categories, so a non-program directory like emulator/ is never swept in.
set -uo pipefail
cd "$(dirname "$0")/.."
cats=()
while IFS= read -r c; do [ -n "$c" ] && cats+=("$c"); done < <(tools/categories.sh)
[ ${#cats[@]} -gt 0 ] || { echo "build: pack.json declares no categories" >&2; exit 2; }
fail=0
shopt -s nullglob
for c in "${cats[@]}"; do
  for h in "$c/harness" "$c"/*/harness "$c"/*/*/harness; do
    [ -x "$h/build.sh" ] || continue
    if ! "$h/build.sh"; then echo "BUILD FAILED: $h/build.sh" >&2; fail=1; fi
  done
done
exit $fail
