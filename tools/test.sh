#!/usr/bin/env bash
# Golden-test every program: each harness/tests/NN.in must reproduce NN.out
# byte-exact through the program's binary. Fixtures whose name contains
# "error" must exit non-zero (a well-formed protocol error); all others zero.
# The golden fixtures ARE the conformance suite (see PACK.md).
set -uo pipefail
cd "$(dirname "$0")/.."
# The categories come from pack.json (tools/categories.sh), not from a list
# kept here. Optional args filter to some of them; no args = all. An argument
# that names no declared category is an error, not a silent no-op.
all_cats=()
while IFS= read -r c; do [ -n "$c" ] && all_cats+=("$c"); done < <(tools/categories.sh)
[ ${#all_cats[@]} -gt 0 ] || { echo "test: pack.json declares no categories" >&2; exit 2; }
cats=("$@"); [ ${#cats[@]} -eq 0 ] && cats=("${all_cats[@]}")
shopt -s nullglob
mans=()
for c in "${cats[@]}"; do
  case " ${all_cats[*]} " in
    *" $c "*) ;;
    *) echo "unknown category: $c (pack declares: ${all_cats[*]})" >&2; exit 2 ;;
  esac
  # Every depth the pack contract uses: <cat>/harness, <cat>/<id>/harness, and
  # a slot nested per interpretation, <cat>/<id>/<interpretation>/harness
  # (docs/games.md §8).
  for h in "$c/harness" "$c"/*/harness "$c"/*/*/harness; do
    [ -f "$h/manifest.json" ] && mans+=("$h/manifest.json")
  done
done
pass=0; fail=0
for man in "${mans[@]}"; do
  hd="$(dirname "$man")"
  prog="${man%/harness/manifest.json}"; prog="${prog#*/}"
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
