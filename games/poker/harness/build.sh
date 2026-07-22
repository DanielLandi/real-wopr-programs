#!/usr/bin/env bash
# Build the poker game. The source is ../main.f90; the binary lands in bin/.
# Requires gfortran. (Run from anywhere — it cd's to its own dir.)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gfortran -std=f2008 -O2 -o "bin/poker" ../main.f90
echo "built games/poker -> harness/bin/poker"
