#!/usr/bin/env bash
# Build the pactel system. Source is ../pactel.c; the compiled binary IS the
# system (no wrapper). K&R/C89 style, dynamic libc. Requires cc or gcc.
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-cc}"
command -v "$CC" >/dev/null 2>&1 || CC=gcc
command -v "$CC" >/dev/null 2>&1 || { echo "build.sh: no C compiler (cc/gcc) on PATH" >&2; exit 1; }
mkdir -p bin
"$CC" -std=c89 -O2 -Wall -o bin/pactel ../pactel.c
echo "built systems/pactel -> harness/bin/pactel"
