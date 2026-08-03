#!/usr/bin/env bash
# W.O.P.R. plays itself with the heuristic rule. NEW puts the opening question
# on the teletype; `0` answers it with zero players and plays self-play game 1
# whole; each further frame sends OBSERVE and plays the next game.
#
# The core interpretation grinds through all nine games and learns futility.
# This one cannot: it has no fork detection, so game 8 (X opens at cell 8)
# forks it and ends the run STATUS WIN. That is the honest outcome and the
# invariant this check pins — a rule player never reaches NO-WIN, which is
# exactly what makes the comparison with the minimax reconstruction worth
# having. Do not "fix" this by faking a draw.
set -euo pipefail
cd "$(dirname "$0")"
BIN=bin/tictactoe
[ -x "$BIN" ] || { echo "missing $BIN — run ./build.sh" >&2; exit 1; }
state="$(printf 'WOPR/1 tictactoe NEW\nSTATE 0\nEND\n' | "$BIN" | sed -n '3,5p')"
st=PLAYING; input=0; last=0
for i in $(seq 1 9); do
  out="$(printf 'WOPR/1 tictactoe MOVE\nSTATE 3\n%s\nINPUT %s\nEND\n' "$state" "$input" | "$BIN")"
  st="$(awk '/^STATUS /{print $2}' <<<"$out")"
  state="$(sed -n '3,5p' <<<"$out")"
  echo "game $i: board=$(sed -n '4p' <<<"$out") status=$st"
  input=OBSERVE; last=$i
  [ "$st" != "PLAYING" ] && break
done
echo "----------------------------------------"
echo "final status: $st after game $last"
[ "$st" = "WIN" ] && [ "$last" = "8" ]
