#!/usr/bin/env bash
# Build the Union Marine Bank system. Source is ../umb.cob; the compiled
# binary lands in bin/umb-cbl, and bin/umb is a wrapper that chdirs to the
# program's folder first so the COBOL's relative ASSIGNs ("data/accounts.dat",
# "data/history.dat") resolve no matter where the host spawns it from — the
# same wrapper pattern airline and the BASIC systems use. Requires GnuCOBOL.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
cobc -x -std=cobol85 -O -o "bin/umb-cbl" "../umb.cob"
cat > bin/umb <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
d="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$d"
exec "$d/harness/bin/umb-cbl"
WRAP
chmod +x bin/umb
echo "built systems/umb -> harness/bin/umb"
