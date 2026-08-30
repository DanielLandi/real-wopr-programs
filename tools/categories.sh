#!/usr/bin/env bash
# Print the pack's program categories, one per line, sorted — DERIVED from
# pack.json, never restated. A category is the first segment of a declared
# program's `path`; pack.json's `programs[]` is itself generated from every
# harness/manifest.json by tools/gen-dial-directory.py, so this is the pack's
# own statement of what it contains.
#
# Every script that walks the programs (build.sh, test.sh, pack.sh, `make
# clean`) reads this instead of carrying its own copy. The engine repo's
# tools/import-programs.sh derives the same list the same way (real-wopr#207);
# a hand-kept copy there is what missed `wopr/` (real-wopr#206).
#
#   tools/categories.sh            # this pack
#   tools/categories.sh <root>     # a pack rooted elsewhere
set -euo pipefail
root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
command -v python3 >/dev/null || { echo "categories: python3 required to read pack.json" >&2; exit 2; }
python3 - "$root/pack.json" <<'PY'
import json, sys
seen = []
for prog in json.load(open(sys.argv[1]))["programs"]:
    cat = prog["path"].split("/")[0]
    if cat not in seen:
        seen.append(cat)
if not seen:
    sys.exit(f"categories: {sys.argv[1]} declares no programs")
print("\n".join(sorted(seen)))
PY
