# Module 3 — API / Emulation Bridge

**Tech:** Python + FastAPI · **Spec:** [`../docs/api-contract.md`](../docs/api-contract.md)

The execution wrapper and router. Per request it: loads `game_state` from Supabase, spawns the
short-lived Fortran core (stdin→stdout), persists the new state, and **routes** each input to
the game engine *or* to Joshua (Claude API). Owns all Supabase and Anthropic access. Stateless:
no in-memory game state.

## Layout

```
api-bridge/
├── app/     # routing, subprocess runner, supabase + claude clients, config
└── tests/   # contract tests; deterministic routing tests that stub Joshua
```

## Status

**Implemented.** All of api-contract.md: REST (session lifecycle, catalog, game state,
clearance-gated DEFCON), the WS stream, the three-way router, the D2 subprocess runner
(pool 4, bounded queue, 2 s SIGKILL timeout -> defined error frame), event logging, and both
Joshua engines.

Key wiring facts:

- **Store:** `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set => hosted Supabase via the
  service-role key (D4; apply `db/migrations/` first). Unset => in-memory store (dev/tests).
- **Joshua:** `JOSHUA_ENABLED=true` + `ANTHROPIC_API_KEY` => Claude with the canonical persona
  prompt, `start_game` tool, prompt caching, 300-token cap, 15 s timeout + one retry, and a
  per-session exchange cap. Otherwise the **scripted 1983 keyword engine** answers — the D5
  kill-switch doubling as feasibility.md §Module 5's "period mode".
- **WS auth (D3/D4):** `/ws/session/{id}` checks the `x-wopr-internal-token` header (comms
  layer only) and the HMAC session token from `POST /api/session`. In deployment the ingress
  never routes `/ws/*` — the era constraints cannot be bypassed.
- **WOPR plays itself:** after a human move that leaves the game PLAYING, the bridge invokes
  the engine side automatically (`MOVE` with INPUT omitted — see `core-fortran/README.md`).

## Run

```bash
cd api-bridge
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"          # + ".[prod]" for supabase/anthropic clients
pytest                            # 36 tests; core golden paths need core-fortran/build.sh
uvicorn app.main:app --port 8000  # env per ../.env.example
```
