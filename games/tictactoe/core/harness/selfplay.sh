#!/usr/bin/env bash
# W.O.P.R. plays itself: the film's finale driven straight at the binary.
# NEW puts the opening question on the teletype; `0` answers it with zero
# players, which plays self-play game 1 whole; each further frame sends
# OBSERVE and plays the next game. Nine games, every one a stalemate, and the
# ninth ends STATUS NO-WIN — "the only winning move is not to play".
set -euo pipefail
cd "$(dirname "$0")"
BIN=bin/tictactoe
[ -x "$BIN" ] || { echo "missing $BIN — run ./build.sh" >&2; exit 1; }
state="$(printf 'WOPR/1 tictactoe NEW\nSTATE 0\nEND\n' | "$BIN" | sed -n '3,5p')"
status=PLAYING; input=0
for i in $(seq 1 9); do
  out="$(printf 'WOPR/1 tictactoe MOVE\nSTATE 3\n%s\nINPUT %s\nEND\n' "$state" "$input" | "$BIN")"
  status="$(awk '/^STATUS /{print $2}' <<<"$out")"
  state="$(sed -n '3,5p' <<<"$out")"
  echo "game $i: board=$(sed -n '4p' <<<"$out") status=$status"
  input=OBSERVE
  [ "$status" != "PLAYING" ] && break
done
echo "----------------------------------------"; echo "final status: $status"
[ "$status" = "NO-WIN" ]
