#!/usr/bin/env bash
# make host — run this machine as a hosted exchange: node host + relay +
# tieline under one supervisor. Ctrl-C hangs up the slot and stops all three.
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
BRIDGE_LOGON_BANNER WOPR_OPERATORS JOSHUA_ENGINE COMMS_MODE DATABASE_URL"
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
SLOTS="WOPR SCHOOL PANAM PROTOVISION PACTEL OTHER-1 OTHER-2"

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

if [ "$JOSHUA_ENGINE" = "lisp" ] && [ ! -x joshua/harness/bin/joshua ]; then
  echo "note: joshua binary missing — run 'make build' for the Lisp engine (falling back to scripted)"
fi

# --- the three processes -----------------------------------------------------
pids=()
cleanup() {
  trap - INT TERM EXIT
  if [ ${#pids[@]} -gt 0 ]; then kill "${pids[@]}" 2>/dev/null || true; fi
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

emulator/node/.venv/bin/python -m uvicorn app.main:app --app-dir emulator/node --port "$BRIDGE_PORT" &
pids+=($!)
for _ in $(seq 1 60); do curl -sf "localhost:${BRIDGE_PORT}/health" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "localhost:${BRIDGE_PORT}/health" >/dev/null || die "node host failed to start on :${BRIDGE_PORT}"

# `exec` so the pid we record is node's own — killing a subshell would leave
# the relay running with the tie line gone.
(cd emulator/relay && exec env BRIDGE_WS_URL="ws://127.0.0.1:${BRIDGE_PORT}" node src/main.ts) &
pids+=($!)
for _ in $(seq 1 30); do curl -sf "localhost:${COMMS_PORT}/trunk/directory" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "localhost:${COMMS_PORT}/trunk/directory" >/dev/null || die "relay failed to start on :${COMMS_PORT}"

TIELINE_LOCAL_COMMS="ws://127.0.0.1:${COMMS_PORT}" TIELINE_LOCAL_BRIDGE="http://127.0.0.1:${BRIDGE_PORT}" \
  node emulator/relay/src/tieline.ts &
pids+=($!)

# Supervise, don't just `wait`. A bare wait returns when *all three* have
# exited, so a tieline that hung up on a refusal would leave the node host and
# relay running and the operator reading a healthy-looking stack that is not
# on the switchboard. Any one of the three going down takes the exchange down.
# (`wait -n` would say this in one line; bash 3.2 — the macOS default — does
# not have it, so poll.) The EXIT trap does the teardown.
while :; do
  for p in "${pids[@]}"; do
    kill -0 "$p" 2>/dev/null || { echo "host: a component exited — shutting down" >&2; exit 1; }
  done
  sleep 1
done
