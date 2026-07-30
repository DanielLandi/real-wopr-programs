#!/usr/bin/env bash
# Install what the harness needs to run the federation.
#
# `make build` compiles the programs and needs only the period toolchains.
# Running them together needs the harness's own dependencies as well: the
# relay and the terminal speak WebSocket, and the node host is a Python
# package. Without these `make up` dies on a missing `ws` — which is a poor
# introduction to a repository whose whole claim is that you can clone it and
# run it.
#
# Idempotent and quiet when there is nothing to do, so `make up` can depend on
# it. Skips any component already installed; pass --force to reinstall.
set -euo pipefail

cd "$(dirname "$0")/.."
force=""
[ "${1:-}" = "--force" ] && force=1

need_node() {
  [ -n "$force" ] || [ ! -d "emulator/$1/node_modules" ]
}

for pkg in relay terminal cli; do
  if need_node "$pkg"; then
    echo "deps: emulator/$pkg"
    (cd "emulator/$pkg" && npm ci --silent)
  fi
done

venv="emulator/node/.venv"
if [ -n "$force" ] || [ ! -x "$venv/bin/python" ]; then
  echo "deps: emulator/node (python venv)"
  python3 -m venv "$venv"
  "$venv/bin/pip" install --quiet --upgrade pip
  "$venv/bin/pip" install --quiet -e "emulator/node"
fi

echo "deps: ready"
