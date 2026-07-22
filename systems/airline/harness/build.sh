#!/usr/bin/env bash
# Build the airline system. Source is ../airline.cob; binary lands in bin/.
# Requires GnuCOBOL (cobc).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
cobc -x -std=cobol85 -O -o "bin/airline" "../airline.cob"
echo "built systems/airline -> harness/bin/airline"
