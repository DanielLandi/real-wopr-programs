#!/usr/bin/env bash
# Build the protovision system. Source is ../protovision.s (6502 assembly);
# cl65 assembles+links it to a .prg, and bin/protovision is a wrapper that
# runs it under sim65. Requires the cc65 suite (cl65 + sim65).
set -euo pipefail
cd "$(dirname "$0")"
for t in cl65 sim65; do
  command -v "$t" >/dev/null 2>&1 || { echo "build.sh: $t not found (install cc65)" >&2; exit 1; }
done
mkdir -p bin
cl65 -t sim6502 -O ../protovision.s -o bin/protovision.prg
cat > bin/protovision <<'WRAP'
#!/usr/bin/env bash
here="$(cd "$(dirname "$0")" && pwd)"
exec sim65 "$here/protovision.prg"
WRAP
chmod +x bin/protovision
echo "built systems/protovision -> harness/bin/protovision"
