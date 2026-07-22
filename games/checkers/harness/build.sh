#!/usr/bin/env bash
# Build the checkers game. The source is ../main.f90; the binary lands in bin/.
# Requires gfortran. (Run from anywhere — it cd's to its own dir.)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gfortran -std=f2008 -O2 -o "bin/checkers" ../main.f90
echo "built games/checkers -> harness/bin/checkers"
