#!/usr/bin/env bash
# Run the programs' extra behavioral checks (engine self-play must draw; the
# GTW simulation must converge on mutual annihilation). These complement the
# golden fixtures with whole-game invariants. Binaries must be built (make build).
#
# Every category pack.json declares is walked (tools/categories.sh), at every
# depth the pack contract uses — this used to glob `games/*` alone, the last
# hand-kept category list in tools/ (#104). A harness opts in by shipping an
# executable selfplay.sh or convergence.sh; categories without one are simply
# silent.
set -uo pipefail
cd "$(dirname "$0")/.."
cats=()
while IFS= read -r c; do [ -n "$c" ] && cats+=("$c"); done < <(tools/categories.sh)
[ ${#cats[@]} -gt 0 ] || { echo "behavior: pack.json declares no categories" >&2; exit 2; }
shopt -s nullglob
fail=0
for c in "${cats[@]}"; do
  for s in "$c"/harness/selfplay.sh "$c"/*/harness/selfplay.sh "$c"/*/*/harness/selfplay.sh \
           "$c"/harness/convergence.sh "$c"/*/harness/convergence.sh "$c"/*/*/harness/convergence.sh; do
    [ -x "$s" ] || continue
    echo "== $s =="
    if ! "$s"; then echo "BEHAVIOR FAILED: $s" >&2; fail=1; fi
  done
done
exit $fail
