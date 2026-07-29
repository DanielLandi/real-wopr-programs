#!/usr/bin/env bash
# Build the pactel system. Source is ../pactel.c; the compiled binary lands
# in bin/pactel-bin, and bin/pactel is a wrapper that chdirs to the
# program's folder first so the C's relative fopens ("data/accounts.dat",
# "data/calls.dat") resolve no matter where the host spawns it from -- the
# same wrapper pattern the COBOL/BASIC systems use. K&R/C89 style, dynamic
# libc. Requires cc or gcc.
set -euo pipefail
cd "$(dirname "$0")"
CC="${CC:-cc}"
command -v "$CC" >/dev/null 2>&1 || CC=gcc
command -v "$CC" >/dev/null 2>&1 || { echo "build.sh: no C compiler (cc/gcc) on PATH" >&2; exit 1; }
mkdir -p bin
"$CC" -std=c89 -O2 -Wall -o bin/pactel-bin ../pactel.c
cat > bin/pactel <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
d="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$d"
exec "$d/harness/bin/pactel-bin"
WRAP
chmod +x bin/pactel
echo "built systems/pactel -> harness/bin/pactel"
