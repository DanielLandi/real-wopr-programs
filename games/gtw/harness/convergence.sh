#!/usr/bin/env bash
# GTW's core claim (docs/games.md §6): the simulation ALWAYS converges on
# mutual annihilation. One first strike, then let it run — the only possible
# terminal status is NO-WIN with the canonical line.
set -euo pipefail

cd "$(dirname "$0")"
BIN=bin/gtw
[ -x "$BIN" ] || { echo "missing $BIN — run ./build.sh" >&2; exit 1; }

req() { # $1 = INPUT line or empty for engine tick
  printf 'WOPR/1 gtw MOVE\nSTATE %s\n%s\n%sEND\n' "$(wc -l <<<"$state" | tr -d ' ')" "$state" "$1"
}

out="$(printf 'WOPR/1 gtw NEW\nSTATE 0\nEND\n' | "$BIN")"
nstate="$(awk '/^STATE /{print $2; exit}' <<<"$out")"
state="$(sed -n "3,$((2 + nstate))p" <<<"$out")"

# The film's play: side 2 (SOVIET UNION), then targets LASVEGAS SEATTLE.
out="$(req $'INPUT 2\n' | "$BIN")"
nstate="$(awk '/^STATE /{print $2; exit}' <<<"$out")"
state="$(sed -n "3,$((2 + nstate))p" <<<"$out")"

out="$(req $'INPUT LASVEGAS SEATTLE\n' | "$BIN")"
status="$(awk '/^STATUS /{print $2}' <<<"$out")"

for i in $(seq 1 80); do
  nstate="$(awk '/^STATE /{print $2; exit}' <<<"$out")"
  state="$(sed -n "3,$((2 + nstate))p" <<<"$out")"
  out="$(req '' | "$BIN")"
  status="$(awk '/^STATUS /{print $2}' <<<"$out")"
  defcon="$(awk '/^DEFCON /{print $2; exit}' <<<"$out")"
  [ "$status" != "PLAYING" ] && { echo "terminal after first strike + $i ticks (DEFCON $defcon)"; break; }
done

echo "final status: $status"
grep -q '^RESULT A STRANGE GAME' <<<"$out" || { echo "missing canonical RESULT"; exit 1; }
[ "$status" = "NO-WIN" ]
