#!/usr/bin/env bash
# Build the airline system. Source is ../airline.cob; the compiled binary
# lands in bin/airline-cbl, and bin/airline is a wrapper that chdirs to the
# program's folder first so the COBOL's relative ASSIGNs ("data/flights.dat",
# "data/passengers.dat") resolve no matter where the host spawns it from —
# the same wrapper pattern the BASIC systems use. Requires GnuCOBOL (cobc).
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
cobc -x -std=cobol85 -O -o "bin/airline-cbl" "../airline.cob"
cat > bin/airline <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
d="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$d"
exec "$d/harness/bin/airline-cbl"
WRAP
chmod +x bin/airline
echo "built systems/airline -> harness/bin/airline"
