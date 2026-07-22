#!/usr/bin/env bash
# Run the games' extra behavioral checks (engine self-play must draw; the GTW
# simulation must converge on mutual annihilation). These complement the golden
# fixtures with whole-game invariants. Binaries must be built (make build).
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
for s in games/*/harness/selfplay.sh games/*/harness/convergence.sh; do
  [ -x "$s" ] || continue
  echo "== $s =="
  if ! "$s"; then echo "BEHAVIOR FAILED: $s" >&2; fail=1; fi
done
exit $fail
