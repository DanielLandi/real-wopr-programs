#!/usr/bin/env bash
# GTW's core claim (docs/games.md §6): the simulation ALWAYS converges on
# mutual annihilation. One first strike, then let it run — the only possible
# terminal status is NO-WIN with the canonical line.
#
# And, since real-wopr#210, the shape of the descent as well as its end: the
# board walks the film's 5-4-3-2-1, one step at a time, and never climbs. A
# fixture cannot say that — it is a property of a whole war, not of one frame
# — so it is asserted here, where the war is already being run.
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

# DEFCON 5 while the war is still being set up, and the levels the board
# shows from here on, in order, with repeats collapsed.
walk="5"
note_defcon() {
  local d
  d="$(awk '/^DEFCON /{print $2; exit}' <<<"$out")"
  [ "$d" = "${walk##* }" ] || walk="$walk $d"
}

out="$(req $'INPUT LASVEGAS SEATTLE\n' | "$BIN")"
status="$(awk '/^STATUS /{print $2}' <<<"$out")"
note_defcon

for i in $(seq 1 80); do
  nstate="$(awk '/^STATE /{print $2; exit}' <<<"$out")"
  state="$(sed -n "3,$((2 + nstate))p" <<<"$out")"
  out="$(req '' | "$BIN")"
  status="$(awk '/^STATUS /{print $2}' <<<"$out")"
  defcon="$(awk '/^DEFCON /{print $2; exit}' <<<"$out")"
  note_defcon
  [ "$status" != "PLAYING" ] && { echo "terminal after first strike + $i ticks (DEFCON $defcon)"; break; }
done

echo "final status: $status"
echo "defcon walk: $walk"
grep -q '^RESULT A STRANGE GAME' <<<"$out" || { echo "missing canonical RESULT"; exit 1; }
[ "$walk" = "5 4 3 2 1" ] || { echo "defcon walked '$walk', want '5 4 3 2 1'"; exit 1; }
[ "$status" = "NO-WIN" ]
