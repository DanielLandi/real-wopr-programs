#!/usr/bin/env bash
# W.O.P.R. plays itself with the heuristic rule: repeated `MOVE` frames with no
# INPUT (engine plays whichever side's TURN it is), each response's 3-line STATE
# fed back as the next request. The rule-based players neutralize each other:
# the game must always end STATUS NO-WIN — same strange game, different player.
set -euo pipefail
cd "$(dirname "$0")"
BIN=bin/tictactoe
[ -x "$BIN" ] || { echo "missing $BIN — run ./build.sh" >&2; exit 1; }
board='.........'; turnline='TURN X'; st=PLAYING
for i in $(seq 1 9); do
  out="$(printf 'WOPR/1 tictactoe MOVE\nSTATE 3\nTTT-H\n%s\n%s\nEND\n' "$board" "$turnline" | "$BIN")"
  st="$(awk '/^STATUS /{print $2}' <<<"$out")"
  board="$(sed -n '4p' <<<"$out")"; turnline="$(sed -n '5p' <<<"$out")"
  echo "move $i: board=$board status=$st"
  [ "$st" != "PLAYING" ] && break
done
echo "----------------------------------------"; echo "final status: $st"
[ "$st" = "NO-WIN" ]
