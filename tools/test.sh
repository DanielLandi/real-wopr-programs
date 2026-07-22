#!/usr/bin/env bash
# Golden-test every program: each harness/tests/NN.in must reproduce NN.out
# byte-exact through the program's binary. Fixtures whose name contains
# "error" must exit non-zero (a well-formed protocol error); all others zero.
# The golden fixtures ARE the conformance suite (see PACK.md).
set -uo pipefail
cd "$(dirname "$0")/.."
# Optional args filter by category (games | systems | joshua); no args = all.
cats=("$@"); [ ${#cats[@]} -eq 0 ] && cats=(games systems joshua)
mans=()
for c in "${cats[@]}"; do
  case "$c" in
    games)   mans+=(games/*/harness/manifest.json) ;;
    systems) mans+=(systems/*/harness/manifest.json) ;;
    joshua)  mans+=(joshua/harness/manifest.json) ;;
    *) echo "unknown category: $c" >&2; exit 2 ;;
  esac
done
pass=0; fail=0
shopt -s nullglob
for man in "${mans[@]}"; do
  hd="$(dirname "$man")"
  prog="$(basename "$(dirname "$hd")")"
  bin_name="$(sed -n 's/.*"binary"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$man")"
  bin="$hd/bin/$bin_name"
  for fin in "$hd"/tests/*.in; do
    fout="${fin%.in}.out"; name="$(basename "$fin" .in)"
    if [ ! -x "$bin" ]; then echo "SKIP $prog/$name — no binary (build it first)"; continue; fi
    actual="$("$bin" < "$fin" 2>/dev/null)"; rc=$?
    ok=1
    if [[ "$name" == *error* ]]; then
      [ $rc -eq 0 ] && { echo "FAIL $prog/$name — expected non-zero exit"; ok=0; }
    else
      [ $rc -ne 0 ] && { echo "FAIL $prog/$name — expected exit 0, got $rc"; ok=0; }
    fi
    diff <(printf '%s\n' "$actual") "$fout" >/dev/null 2>&1 || { echo "FAIL $prog/$name — output differs from $(basename "$fout")"; ok=0; }
    if [ $ok -eq 1 ]; then pass=$((pass+1)); else fail=$((fail+1)); fi
  done
done
echo "----------------------------------------"
echo "golden: $pass passed, $fail failed"
[ $fail -eq 0 ]
