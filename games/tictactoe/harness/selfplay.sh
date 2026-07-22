#!/usr/bin/env bash
# W.O.P.R. plays itself: drive a full game with repeated `MOVE` frames carrying
# no INPUT line (engine plays whichever side's TURN it is), feeding each
# response's STATE block back as the next request. Perfect play must always
# end STATUS NO-WIN — "the only winning move is not to play".
set -euo pipefail
cd "$(dirname "$0")"
BIN=bin/tictactoe
[ -x "$BIN" ] || { echo "missing $BIN — run ./build.sh" >&2; exit 1; }
board='.........'; turnline='TURN X'; status=PLAYING
for i in $(seq 1 9); do
  out="$(printf 'WOPR/1 tictactoe MOVE\nSTATE 2\n%s\n%s\nEND\n' "$board" "$turnline" | "$BIN")"
  status="$(awk '/^STATUS /{print $2}' <<<"$out")"
  board="$(sed -n '3p' <<<"$out")"; turnline="$(sed -n '4p' <<<"$out")"
  echo "move $i: board=$board status=$status"
  [ "$status" != "PLAYING" ] && break
done
echo "----------------------------------------"; echo "final status: $status"
[ "$status" = "NO-WIN" ]
