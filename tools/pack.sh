#!/usr/bin/env bash
# Produce dist/real-wopr-programs.woprpack — a single tar.gz of the pack
# (pack.json + every program's source, harness, manifest and tests), excluding
# build output. This is the importable artifact (see PACK.md); an operator drops
# it into their engine's packs/ and imports it. Fans publish their own the same way.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p dist
tar --exclude='*/harness/bin' --exclude='./dist' --exclude='./.git' \
    -czf dist/real-wopr-programs.woprpack \
    pack.json PACK.md games systems joshua
echo "packed: dist/real-wopr-programs.woprpack"
