#!/usr/bin/env bash
# Build the blackjack game. The source is ../main.f90; the binary lands in bin/.
# Requires gfortran. (Run from anywhere — it cd's to its own dir.)
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
gfortran -std=f2008 -O2 -o "bin/blackjack" ../main.f90
echo "built games/blackjack -> harness/bin/blackjack"
