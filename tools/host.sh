#!/usr/bin/env bash
# make host — run this machine as a hosted exchange: node host + relay under
# one supervisor. Ctrl-C hangs up the slot and stops both.
#
# The tie line used to be a third process. It now runs INSIDE the relay, so
# that a callback Joshua wants to place can go out over the trunk instead of
# into a switchboard that has never heard of the visitor's handle
# (real-wopr-programs#75). `npm run tieline` still works for a stack you wired
# yourself; this script no longer uses it. One consequence worth knowing: a
# terminal refusal (LINE REFUSED, a taken slot) used to end the tieline process
# and take the whole stack down with it. Now it prints LINE REFUSED and leaves
# the relay serving locally — read the output, do not assume a quiet stack is a
# connected one.
#
# The hub is only a switchboard. Every game, session and transcript stays on
# this machine; the hub lists your number and relays calls while the tie line
# is up, and the slot opens again the moment you hang up.
set -euo pipefail
cd "$(dirname "$0")/.."

# A `.env` at the pack root is the file host.html tells operators to write, and
# nothing else in the pack reads one — config.py sees the environment and only
# the environment. Read it here, before the guards, so what it sets is checked
# like anything else. `set -a` exports every assignment, so both `KEY=val` and
# `export KEY=val` lines work.
#
# The command line wins. host.html hands operators a one-line
# `TIELINE_SLOT=... make host`, and the README suggests a .env for the same
# variables; if the file quietly beat the line the operator just typed, they
# would watch the wrong slot go up with nothing to explain it. So snapshot
# whatever the surrounding shell already set, source the file, put the
# snapshot back. (bash 3.2: no associative arrays, no `${!name}` games beyond
# eval on these fixed identifiers.)
# TIELINE_RESERVE_KEY is snapshotted like the rest but never validated: it is
# opaque here — only the hub can say whether it is the right key.
HOST_ENV_VARS="TIELINE_SLOT TIELINE_WORLD TIELINE_NAME TIELINE_REGION
TIELINE_JOSHUA TIELINE_OPERATOR TIELINE_RESERVE_KEY TRUNK_HUB_URL
BRIDGE_TRUNK_URL BRIDGE_LOGON_BANNER WOPR_OPERATORS JOSHUA_ENGINE COMMS_MODE
DATABASE_URL"
if [ -f .env ]; then
  host_preset=""
  for v in $HOST_ENV_VARS; do
    if eval "[ -n \"\${$v+x}\" ]"; then
      eval "host_preset_$v=\$$v"
      host_preset="$host_preset $v"
    fi
  done
  set -a; . ./.env; set +a
  for v in $host_preset; do
    eval "$v=\$host_preset_$v"
    export "$v"
  done
fi

die() { echo "host: $*" >&2; exit 1; }
upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# --- what the hub will accept -----------------------------------------------
# A malformed REGISTER is refused with a *non-terminal* close, so the tieline
# redials it forever. Every check the hub makes on the fields we send is made
# here first, where a typo is still a one-line error the operator can read.

# No HOME: that is the caller's own seat, not a service anyone hosts. The hub's
# roster leaves it out too, so a REGISTER claiming it would not even decode.
SLOTS="WOPR SCHOOL PANAM PROTOVISION PACTEL BANK OTHER-1 OTHER-2"

if [ -n "${TIELINE_SLOT:-}" ]; then
  TIELINE_SLOT=$(upper "$TIELINE_SLOT")
  case " $SLOTS " in
    *" $TIELINE_SLOT "*) ;;
    *) die "TIELINE_SLOT must be one of: $SLOTS" ;;
  esac
  export TIELINE_SLOT
fi

if [ -n "${TIELINE_WORLD:-}" ]; then
  TIELINE_WORLD=$(upper "$TIELINE_WORLD")
  case "$TIELINE_WORLD" in
    NEW) ;;
    *[!0-9]*) die "TIELINE_WORLD must be a world number or NEW" ;;
    *) [ "$TIELINE_WORLD" -ge 1 ] || die "TIELINE_WORLD must be a world number (1 or greater) or NEW" ;;
  esac
  export TIELINE_WORLD
fi

case "${TIELINE_JOSHUA:-period}" in
  period|claude) ;;
  *) die "TIELINE_JOSHUA must be period or claude" ;;
esac

check_len() { # name value min max
  [ "${#2}" -ge "$3" ] && [ "${#2}" -le "$4" ] ||
    die "$1 must be $3-$4 characters — the phone book prints it (got ${#2})"
}
check_len TIELINE_NAME "${TIELINE_NAME:-UNNAMED EXCH}" 2 24
check_len TIELINE_REGION "${TIELINE_REGION:-SOMEWHERE}" 2 24
check_len TIELINE_OPERATOR "${TIELINE_OPERATOR:-}" 0 24

# --- dependencies ------------------------------------------------------------
# Idempotent, and the subset of tools/deps.sh this path needs, so that
# `tools/host.sh` on its own works as well as `make host` does.
[ -d emulator/node/.venv ] || python3 -m venv emulator/node/.venv
emulator/node/.venv/bin/python -c "import app" >/dev/null 2>&1 || \
  emulator/node/.venv/bin/pip install -q --disable-pip-version-check -e "emulator/node[dev]"
[ -d emulator/relay/node_modules ] || (cd emulator/relay && npm install --no-fund --no-audit)

: "${JOSHUA_ENGINE:=lisp}"
: "${COMMS_MODE:=authentic}"
: "${BRIDGE_INTERNAL_TOKEN:=$(openssl rand -hex 16)}"
: "${BRIDGE_SESSION_SECRET:=$(openssl rand -hex 16)}"
: "${BRIDGE_PORT:=8000}"
: "${COMMS_PORT:=8081}"
export JOSHUA_ENGINE COMMS_MODE BRIDGE_INTERNAL_TOKEN BRIDGE_SESSION_SECRET BRIDGE_PORT COMMS_PORT

# The relay dials out as a peer when TRUNK_HUB_URL is set, so set it — the
# default is the documented one, and `make host` means "be a hosted exchange".
# A relay with a seeded world 1 (TRUNK_LOCAL_WORLD) refuses to hold a tie line
# regardless: a hub is never a peer.
: "${TRUNK_HUB_URL:=wss://wopr.realwopr.ai/trunk}"
# Where the bridge reaches its own relay to place a call. On a hosted exchange
# that is loopback by construction, so it is derived rather than asked for —
# unset, Joshua forms the intention to ring a visitor back and rings nobody.
# (The flagship's compose still sets it by hand: there the two are separate
# containers and `comms` is not on loopback.) A value already in the
# environment or the .env wins, like everything else here.
: "${BRIDGE_TRUNK_URL:=http://127.0.0.1:${COMMS_PORT}}"
export TRUNK_HUB_URL BRIDGE_TRUNK_URL

if [ "$JOSHUA_ENGINE" = "lisp" ] && [ ! -x joshua/harness/bin/joshua ]; then
  echo "note: joshua binary missing — run 'make build' for the Lisp engine (falling back to scripted)"
fi

# --- the two processes -------------------------------------------------------
pids=()
cleanup() {
  trap - INT TERM EXIT
  if [ ${#pids[@]} -gt 0 ]; then kill "${pids[@]}" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

emulator/node/.venv/bin/python -m uvicorn app.main:create_app --factory --app-dir emulator/node --port "$BRIDGE_PORT" &
pids+=($!)
for _ in $(seq 1 60); do curl -sf "localhost:${BRIDGE_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "localhost:${BRIDGE_PORT}/health" >/dev/null || die "node host failed to start on :${BRIDGE_PORT}"

# `exec` so the pid we record is node's own — killing a subshell would leave
# the relay (and the tie line inside it) running.
(cd emulator/relay && exec env BRIDGE_WS_URL="ws://127.0.0.1:${BRIDGE_PORT}" node src/main.ts) &
pids+=($!)
for _ in $(seq 1 30); do curl -sf "localhost:${COMMS_PORT}/trunk/directory" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "localhost:${COMMS_PORT}/trunk/directory" >/dev/null || die "relay failed to start on :${COMMS_PORT}"

# Supervise, don't just `wait`. A bare wait returns when *both* have exited, so
# a node host that died would leave the relay running and the operator reading
# a healthy-looking stack with no programs behind it. Either one going down
# takes the exchange down.
# (`wait -n` would say this in one line; bash 3.2 — the macOS default — does
# not have it, so poll.) The EXIT trap does the teardown.
while :; do
  for p in "${pids[@]}"; do
    kill -0 "$p" 2>/dev/null || { echo "host: a component exited — shutting down" >&2; exit 1; }
  done
  sleep 1
done
