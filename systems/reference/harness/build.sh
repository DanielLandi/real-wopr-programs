#!/usr/bin/env bash
# Build the reference system. Source is ../reference.cob; binary lands in bin/.
# Requires GnuCOBOL (cobc).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
cobc -x -std=cobol85 -O -o "bin/reference" "../reference.cob"
echo "built systems/reference -> harness/bin/reference"
