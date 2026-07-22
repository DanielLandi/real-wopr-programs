#!/usr/bin/env bash
# Build the Falken Dialogue Processor into a standalone executable. Source is
# ../src/*.lisp (package -> corpus -> engine -> main, in that load order).
# Requires SBCL.
set -euo pipefail
cd "$(dirname "$0")"
command -v sbcl >/dev/null 2>&1 || { echo "build.sh: sbcl not found on PATH" >&2; exit 1; }
mkdir -p bin
sbcl --non-interactive \
     --load ../src/package.lisp \
     --load ../src/corpus.lisp \
     --load ../src/engine.lisp \
     --load ../src/main.lisp \
     --eval '(sb-ext:save-lisp-and-die "bin/joshua" :executable t :toplevel (function joshua:main) :compression nil)' \
     > /dev/null
echo "built joshua -> harness/bin/joshua"
