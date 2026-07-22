#!/usr/bin/env bash
# Build the gin-rummy game. The source is ../main.f90; the binary lands in bin/.
# Requires gfortran. (Run from anywhere — it cd's to its own dir.)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gfortran -std=f2008 -O2 -o "bin/gin-rummy" ../main.f90
echo "built games/gin-rummy -> harness/bin/gin-rummy"
