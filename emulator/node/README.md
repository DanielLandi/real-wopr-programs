# emulator/node — the node host

**Tech:** Python + FastAPI · **Spec:** `docs/api-contract.md` in the private engine repo
([`real-wopr`](https://github.com/DanielLandi/real-wopr); sibling checkout:
`../real-wopr/docs/api-contract.md`)

The execution wrapper and connection monitor. Per request it: loads `game_state` from the store
(Postgres/Neon or in-memory), spawns the short-lived Fortran core (stdin→stdout), persists the new state, and **attaches**
each session to exactly one program — a game, Joshua (Claude API), or NORAD ops — so every
non-reserved line goes there until the attachment ends. Owns all database and Anthropic access.
Stateless: no in-memory game state.

## Layout

```
emulator/node/
├── app/     # routing, subprocess runner, postgres + claude clients, config
└── tests/   # contract tests; deterministic routing tests that stub Joshua
```

## Status

**Implemented.** All of api-contract.md: REST (session lifecycle, catalog, game state,
clearance-gated DEFCON), the WS stream, the attachment-based connection monitor, the D2
subprocess runner (pool 4, bounded queue, 2 s SIGKILL timeout -> defined error frame), event
logging, and both Joshua engines.

Key wiring facts:

- **Store:** `DATABASE_URL` set => PostgresStore (plain Postgres, Neon in production).
  Unset => MemoryStore (dev/tests). Schema lives at `emulator/node/db/migrations/`,
  applied in deployment by the engine repo's `db/apply.sh`.
- **Joshua:** `JOSHUA_ENABLED=true` + `ANTHROPIC_API_KEY` => Claude with the canonical persona
  prompt, `start_game` tool, prompt caching, 300-token cap, 15 s timeout + one retry, and a
  per-session exchange cap. Otherwise the **scripted 1983 keyword engine** answers — the D5
  kill-switch doubling as feasibility.md §Module 5's "period mode".
- **WS auth (D3/D4):** `/ws/session/{id}` checks the `x-wopr-internal-token` header (comms
  layer only) and the HMAC session token from `POST /api/session`. In deployment the ingress
  never routes `/ws/*` — the era constraints cannot be bypassed.
- **Session auth (#74):** `POST /api/session` authenticates nobody, deliberately — every
  visitor surface is one a stranger is supposed to open, and a minted session lands at
  `LOGON:` paced at that surface's baud. The exception is `INTERNAL_SURFACES`
  (`trunk-call`, `trunk-caller`): the machine ends of a machine call are behind the front
  door on connect and run at profile `off`, so they require the same
  `x-wopr-internal-token` header, and only they do. With `BRIDGE_INTERNAL_TOKEN` unset the
  two machine surfaces are refused outright (`400 unknown surface`) and startup logs a
  warning — unlike the WS guard above, this endpoint has no second factor to fall back on.
- **WOPR plays itself:** after a human move that leaves the game PLAYING, the node host
  invokes the engine side automatically (`MOVE` with INPUT omitted — see `PACK.md`
  §Wire protocols).

## Run

```bash
cd emulator/node
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"          # + ".[prod]" for postgres/anthropic clients
pytest                            # program-spawning paths need `make build` at the pack root
uvicorn app.main:app --port 8000
```
