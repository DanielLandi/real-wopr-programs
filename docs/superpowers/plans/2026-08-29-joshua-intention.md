# Piece D — Joshua's Intention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Joshua forms an intention to keep looking for Falken when it discloses the DOD pension dossier, and places one call to the visitor's home terminal when that visitor hangs up.

**Architecture:** The Lisp corpus signals the intention on its existing keyed `INTENT` trailer; the Python engines surface it as a new field on `JoshuaReply` beside `start_game_id`; the node host holds it as a local in the session coroutine and, in that coroutine's `finally`, sends one `POST /trunk/place` to the relay using the seat handle the relay disclosed at connect. The terminal gains a `/seat` client so a ring can actually be answered.

**Tech Stack:** SBCL (the Falken Dialogue Processor), Python 3.12 + FastAPI + pytest (the node host), TypeScript on Node ≥ 23.6 native type-stripping + `node --test` (the terminal and relay), React (the home-terminal surface).

**Spec:** `../real-wopr/docs/superpowers/specs/2026-08-29-joshua-intention-design.md` — read it before Task 1. §2 (a busy seat cannot be rung) and §5 (the wire) are the two sections every task argues from.

## Global Constraints

- **Repo rules:** this plan is executed in `real-wopr-programs`, a **Tier A** repo. Branch → PR → CI green → `gh pr merge --squash`. No direct push to `main`. The nine required checks are `programs`, `node`, `relay`, `web`, `devkit`, `images`, `terminal`, `federation`, `cli`.
- **Period discipline:** the Lisp program is a 1983-honest artifact. It never learns that a trunk, a socket, or an HTTP request exists. It signals what it wants on the wire it already has; the modern harness does the modern thing. Read `CONTRIBUTING.md` before touching anything under `joshua/`.
- **Determinism:** no wall clock, no unseeded randomness, anywhere in program code or fixtures.
- **Golden fixtures are byte-exact.** `joshua/harness/tests/*.out` is compared byte for byte. A changed reply means a regenerated fixture, reviewed as a diff.
- **The two deterministic engines must not drift.** `ScriptedJoshua` and the Lisp F.D.P. emit the film beats byte-identically (real-wopr#161). Any change to one is a change to both.
- **Teletype contract:** every line Joshua emits is uppercase and ≤ 60 characters.
- **The intention is a latch, not a counter.** At most one placement per session, however many times the trigger fires.
- **Never send `world` or `slot` alongside `seat`** in a `POST /trunk/place` body. The hub discriminates on `seat` (`emulator/relay/src/server.ts:1034`) and ignores the rest; sending them reads as precision and is dead weight.

---

## File Structure

**Modified — the Lisp program (`joshua/`)**
- `src/engine.lisp` — the dossier branch gains an intent; three game branches are re-tagged.
- `src/main.lisp` — `write-response` dispatches on the intent's tag; the wire comment gains the new line.
- `harness/tests/54-falken-dossier.out` — regenerated, now carrying `INTENT SEEK FALKEN`.

**Modified — the node host (`emulator/node/app/`)**
- `joshua.py` — `JoshuaReply.seeks`; set in `ScriptedJoshua`, parsed in `LispJoshua`, read from a tool block in `ClaudeJoshua`.
- `router.py` — carries `seeks` up on `RouteResult`.
- `config.py` — the relay's HTTP base.
- `main.py` — the `ORIGIN` control branch, the two locals, and the deferred placement.

**Created — the node host**
- `emulator/node/app/callback.py` — placing the call. One function, no websocket, no FastAPI: this is where the placement is unit-tested without standing up a session.

**Created / modified — the terminal**
- `emulator/terminal/src/seat.ts` — `WoprSeat` (created).
- `emulator/terminal/src/protocol.ts` — `WoprLink` gains a `seat` option (modified).
- `emulator/web/home-terminal/app/page.tsx` — holds one seat, renders the ring, answers or declines (modified).

**Tests**
- `emulator/node/tests/test_callback.py`, `test_joshua_seeks.py`, `test_session_intention.py` (created).
- `emulator/terminal/tests/seat.test.ts` (created).

---

### Task 1: The Lisp corpus signals the intention

**Files:**
- Modify: `joshua/src/engine.lisp:591` (`finish`'s contract), `:614` (the dossier branch), `:645`, `:653`, `:655` (the three game branches)
- Modify: `joshua/src/main.lisp:10` (wire comment), `:47-51` (`write-response`)
- Modify: `joshua/harness/tests/54-falken-dossier.out`

**Interfaces:**
- Consumes: nothing.
- Produces: the JOSHUA/1 wire gains an optional trailer line `INTENT SEEK FALKEN`, emitted only with the dossier reply. `INTENT START-GAME <id>` is unchanged on the wire. Task 2's `LispJoshua` parses the new line.

**Why the intent slot is re-tagged rather than a sentinel:** `respond` already returns `(reply . intent)` and `write-response` prints one optional `INTENT` line. Only three branches ever set a non-`nil` intent, so tagging the value costs five edited lines and keeps the slot honestly typed. A magic string like `"SEEK-FALKEN"` in a slot documented as a game id would be smaller and would be the thing a reviewer rejects.

- [ ] **Step 1: Write the failing fixture**

Create the input fixture — it already exists, so only the expected output changes. Edit `joshua/harness/tests/54-falken-dossier.out` to:

```
JOSHUA/1 OK
REPLY 4
DOD PENSION FILES INDICATE CURRENT MAILING AS:
DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)
5 TALL CEDAR ROAD
GOOSE ISLAND, OREGON 97014
INTENT SEEK FALKEN
END
```

- [ ] **Step 2: Run the fixture to verify it fails**

Run: `tools/test.sh joshua`
Expected: FAIL — `54-falken-dossier` differs, because the program still emits no `INTENT` line for the dossier.

- [ ] **Step 3: Re-tag the intent in `engine.lisp`**

At `joshua/src/engine.lisp:614`, the dossier branch currently reads:

```lisp
        ((and (dossier-request-p input history)
              (not (explicit-game-request-p input act)))
         (finish '("DOD PENSION FILES INDICATE CURRENT MAILING AS:"
                   "DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)"
                   "5 TALL CEDAR ROAD"
                   "GOOSE ISLAND, OREGON 97014")
                 nil))
```

Change its intent from `nil` to a tagged seek. The machine has just located Falken; this is it deciding to keep looking:

```lisp
        ((and (dossier-request-p input history)
              (not (explicit-game-request-p input act)))
         (finish '("DOD PENSION FILES INDICATE CURRENT MAILING AS:"
                   "DR. ROBERT HUME (A.K.A. STEPHEN W. FALKEN)"
                   "5 TALL CEDAR ROAD"
                   "GOOSE ISLAND, OREGON 97014")
                 '(:seek . "FALKEN")))
```

Then re-tag the three game branches so the slot has one representation. At `:645` and `:653`, `(finish '("FINE.") "gtw")` becomes:

```lisp
         (finish '("FINE.") '(:start-game . "gtw"))
```

At `:655`, `(finish (list ...) (cdr game))` — whatever expression currently supplies the id — becomes `(cons :start-game <that same expression>)`. Read the line before editing; do not guess the accessor.

Update `finish`'s docstring at `:591` to say the intent is `NIL`, `(:START-GAME . id)`, or `(:SEEK . who)`.

- [ ] **Step 4: Dispatch in `main.lisp`**

Replace `joshua/src/main.lisp:49`:

```lisp
  (when intent (format t "INTENT START-GAME ~A~%" intent))
```

with a dispatch on the tag:

```lisp
  (when intent
    (ecase (car intent)
      (:start-game (format t "INTENT START-GAME ~A~%" (cdr intent)))
      (:seek       (format t "INTENT SEEK ~A~%" (cdr intent)))))
```

`ecase` rather than `case`: an unhandled tag is a corpus bug, and failing loudly in a subprocess the host already falls back from is better than silently dropping an intention.

Update the wire comment at `main.lisp:10` so the protocol block lists both trailers:

```lisp
;;;;   A <text>                          INTENT START-GAME <id>   (optional)
;;;;   INPUT <text>                      INTENT SEEK <who>        (optional)
```

- [ ] **Step 5: Run the whole Joshua suite**

Run: `tools/test.sh joshua`
Expected: PASS — `54-falken-dossier` now matches, and `05-gtw-insist-intent`, `06-tictactoe-intent`, `20-title-only-tictactoe` still emit `INTENT START-GAME` byte-identically. If any game fixture changed, the re-tagging in Step 3 is wrong; fix it rather than regenerating the fixture.

- [ ] **Step 6: Commit**

```bash
git add joshua/src/engine.lisp joshua/src/main.lisp joshua/harness/tests/54-falken-dossier.out
git commit -m "joshua: the dossier carries an intention to keep looking"
```

---

### Task 2: `JoshuaReply.seeks` across the three engines

**Files:**
- Modify: `emulator/node/app/joshua.py:96-98` (`JoshuaReply`), `:163-164` (`ScriptedJoshua`), `:238-244` (`LispJoshua`), `:300-311` (`ClaudeJoshua`)
- Test: `emulator/node/tests/test_joshua_seeks.py` (create)

**Interfaces:**
- Consumes: Task 1's `INTENT SEEK FALKEN` wire line.
- Produces: `JoshuaReply(text: str, start_game_id: str | None = None, seeks: str | None = None)`. Task 3 reads `.seeks`.

- [ ] **Step 1: Write the failing test**

Create `emulator/node/tests/test_joshua_seeks.py`:

```python
"""The intention rides on JoshuaReply, beside start_game_id.

The dossier is the trigger (spec §4) because it is the one deterministic
beat both engines already share byte-identically. These tests pin that the
signal reaches Python from each engine, not that the text is right — the
golden fixtures already own the text.
"""
import pytest

from app.joshua import FALKEN_DOSSIER, JoshuaReply, ScriptedJoshua


def test_reply_defaults_to_no_intention():
    assert JoshuaReply(text="HELLO.").seeks is None


@pytest.mark.asyncio
async def test_scripted_engine_seeks_falken_with_the_dossier():
    joshua = ScriptedJoshua(programs=[])
    history = [
        {"role": "user", "content": "JOSHUA"},
        {"role": "assistant", "content": "GREETINGS PROFESSOR FALKEN."},
    ]
    reply = await joshua.chat("s1", history, "IS FALKEN DEAD?")
    assert reply.text == FALKEN_DOSSIER
    assert reply.seeks == "FALKEN"


@pytest.mark.asyncio
async def test_scripted_engine_seeks_nothing_otherwise():
    joshua = ScriptedJoshua(programs=[])
    reply = await joshua.chat("s1", [], "HELLO")
    assert reply.seeks is None
```

`ScriptedJoshua`'s constructor signature may differ — read it at `joshua.py:125` and match it. If it needs a program list, pass an empty one.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd emulator/node && python -m pytest tests/test_joshua_seeks.py -v`
Expected: FAIL — `TypeError: JoshuaReply.__init__() got an unexpected keyword argument` on the first test, or `AttributeError` on `.seeks`.

- [ ] **Step 3: Add the field and set it in all three engines**

In `emulator/node/app/joshua.py`, extend the dataclass at `:96`:

```python
class JoshuaReply:
    text: str
    start_game_id: str | None = None
    # What the machine decided to keep looking for, if anything. The host
    # acts on it; the program never learns what "acting" means. Exactly the
    # division start_game_id already runs on — an engine says what it wants,
    # and the modern harness does the modern thing.
    seeks: str | None = None
```

`ScriptedJoshua` at `:164`:

```python
        if falken_on_the_table and any(w in t for w in DOSSIER_TRIGGERS):
            return JoshuaReply(text=FALKEN_DOSSIER, seeks="FALKEN")
```

`LispJoshua` at `:238-244` — the trailer loop currently matches one prefix. Add the second, and keep them independent so a reply carrying both would surface both:

```python
            intent = None
            seeks = None
            for line in lines[2 + k:]:
                if line.startswith("INTENT START-GAME "):
                    intent = line.split()[-1]
                elif line.startswith("INTENT SEEK "):
                    seeks = line.split()[-1]
            if not reply:
                raise ValueError("empty reply")
            return JoshuaReply(text=reply, start_game_id=intent, seeks=seeks)
```

`ClaudeJoshua` at `:300-311` — it already walks tool-use blocks for `game_id`. Add the sibling, following whatever block-name convention the existing code uses (read `:304-311` and match it exactly rather than inventing a name):

```python
        start_game_id: str | None = None
        seeks: str | None = None
        for block in ...:                      # the existing loop, unchanged
            if ...:                            # the existing game branch
                start_game_id = str(block.input.get("game_id", "")) or None
            elif ...:                          # the new seek branch
                seeks = str(block.input.get("seeks", "")) or None
        return JoshuaReply(text=text, start_game_id=start_game_id, seeks=seeks)
```

The Claude path is not covered by the evals (which run `scripted` and `lisp`), so it must not be the only engine that works. It is included for parity, not relied on.

- [ ] **Step 4: Run the tests**

Run: `cd emulator/node && python -m pytest tests/test_joshua_seeks.py -v`
Expected: PASS, 3 tests.

- [ ] **Step 5: Run the whole node suite for regressions**

Run: `cd emulator/node && python -m pytest -q`
Expected: PASS. `start_game_id` behaviour is untouched; if a game test fails, the `LispJoshua` loop edit broke the existing prefix match.

- [ ] **Step 6: Commit**

```bash
git add emulator/node/app/joshua.py emulator/node/tests/test_joshua_seeks.py
git commit -m "node: an engine can say what it is still looking for"
```

---

### Task 3: The router carries the intention up

**Files:**
- Modify: `emulator/node/app/router.py:55-56` (`RouteResult`), `:703-716` (the Joshua branch)
- Test: `emulator/node/tests/test_joshua_seeks.py` (extend)

**Interfaces:**
- Consumes: `JoshuaReply.seeks` from Task 2.
- Produces: `RouteResult.seeks: str | None`. Task 7 reads it off the value `router.handle(...)` returns.

**Note on the event log:** the existing code logs `{"input": ..., "reply": ..., "start_game": ...}` at `:707`. Add `"seeks"` to the same dict. An intention that was formed and then dropped because the seat was gone is exactly the thing someone will later want to find in the history, and it costs one key.

- [ ] **Step 1: Write the failing test**

Append to `emulator/node/tests/test_joshua_seeks.py`:

```python
@pytest.mark.asyncio
async def test_router_carries_seeks_up(router_with_scripted_joshua):
    """The host, not the program, decides what an intention means — so the
    intention has to survive the trip out of the router."""
    r = router_with_scripted_joshua
    await r.handle("s1", "JOSHUA")
    result = await r.handle("s1", "IS FALKEN DEAD?")
    assert result.seeks == "FALKEN"


@pytest.mark.asyncio
async def test_router_reports_no_intention_for_an_ordinary_turn(
        router_with_scripted_joshua):
    result = await router_with_scripted_joshua.handle("s1", "HELLO")
    assert result.seeks is None
```

`router_with_scripted_joshua` is a fixture you must write, or an existing one you must find. Read `emulator/node/tests/` for how other router tests construct a `Router` — there is almost certainly a conftest fixture already; reuse it rather than building a second way to make one. `handle`'s exact name and signature are at `router.py` — read them; this plan does not guess them.

- [ ] **Step 2: Run to verify it fails**

Run: `cd emulator/node && python -m pytest tests/test_joshua_seeks.py -v -k router`
Expected: FAIL — `AttributeError: 'RouteResult' object has no attribute 'seeks'`.

- [ ] **Step 3: Add the field and populate it**

In `emulator/node/app/router.py`, add to the `RouteResult` dataclass at `:56`:

```python
    seeks: str | None = None
```

Place it after the existing optional fields so no positional construction elsewhere breaks. Then in the Joshua branch, both return paths must carry it — the game path at `:714` as well as the plain one at `:716`, because a reply can in principle carry both:

```python
        await store.log_event(session_id, "route", "joshua",
                              {"input": raw, "reply": reply.text,
                               "start_game": reply.start_game_id,
                               "seeks": reply.seeks})
        if reply.start_game_id:
            ...
            started = await self._new_game(session_id, reply.start_game_id, room)
            return RouteResult(text=f"{reply.text}\n\n{started.text}", route="joshua",
                               detail={"start_game": reply.start_game_id},
                               seeks=reply.seeks)
        return RouteResult(text=reply.text, route="joshua", seeks=reply.seeks)
```

- [ ] **Step 4: Run the tests**

Run: `cd emulator/node && python -m pytest tests/test_joshua_seeks.py -v`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add emulator/node/app/router.py emulator/node/tests/test_joshua_seeks.py
git commit -m "node: an intention survives the trip out of the router"
```

---

### Task 4: The bridge learns the relay's address

**Files:**
- Modify: `emulator/node/app/config.py`
- Test: `emulator/node/tests/test_callback.py` (created in Task 5 — this task adds no test of its own beyond the suite still passing)

**Interfaces:**
- Consumes: nothing.
- Produces: `settings.trunk_url: str` — the relay's HTTP base, e.g. `http://comms:8081`, empty string when unset. Task 5 and Task 7 read it.

**Why this is its own task:** it inverts a dependency edge. Today the relay dials the bridge and the bridge has no address for the relay at all (spec §5). This is the first traffic in the other direction, and it is worth a reviewer's separate look at the default and the unset behaviour before anything depends on it.

- [ ] **Step 1: Add the setting**

Read `emulator/node/app/config.py` and follow its existing pattern exactly — it already reads `BRIDGE_INTERNAL_TOKEN` and `BRIDGE_CORS_ORIGINS`, so match how those are declared, defaulted and typed. Add:

```python
    # The relay's HTTP base, for the one thing the bridge asks the relay to
    # do: place a call on behalf of the flagship's own Joshua line
    # (POST /trunk/place). Empty means "no hub" — a monolith, or a dev box —
    # and the callback becomes a logged no-op rather than an error. Every
    # other exchange between these two services runs the other way, relay to
    # bridge; this is the only edge pointing back.
    trunk_url: str = os.environ.get("BRIDGE_TRUNK_URL", "")
```

Adjust the declaration form to whatever `config.py` actually uses (pydantic `BaseSettings`, a plain dataclass, `os.environ` reads). Do not introduce a second configuration style.

- [ ] **Step 2: Run the suite**

Run: `cd emulator/node && python -m pytest -q`
Expected: PASS, unchanged count. A new optional setting breaks nothing.

- [ ] **Step 3: Commit**

```bash
git add emulator/node/app/config.py
git commit -m "node: the bridge learns where its relay is"
```

---

### Task 5: Placing the call

**Files:**
- Create: `emulator/node/app/callback.py`
- Test: `emulator/node/tests/test_callback.py` (create)

**Interfaces:**
- Consumes: `settings.trunk_url` (Task 4), `settings.internal_token`.
- Produces: `async def place_seat_call(trunk_url: str, internal_token: str, handle: str, *, timeout_s: float = 5.0) -> str` — returns `"placed"`, or a refusal reason string. **Never raises.** Task 7 calls it.

**Why a separate module:** the placement is the one piece of this feature that can be tested without standing up a websocket session. Keeping it out of `main.py` is what makes Task 7's tests about *when* the call is placed rather than about HTTP.

- [ ] **Step 1: Write the failing test**

Create `emulator/node/tests/test_callback.py`:

```python
"""Placing the callback.

The contract this file pins hardest: place_seat_call NEVER raises. It runs
inside ws_session's `finally`, during teardown, where an exception does not
fail a callback — it fails the disconnect (spec §5).
"""
import pytest
from aiohttp import web

from app.callback import place_seat_call


async def _hub(aiohttp_server, handler):
    app = web.Application()
    app.router.add_post("/trunk/place", handler)
    return await aiohttp_server(app)


@pytest.mark.asyncio
async def test_places_the_call_and_sends_only_the_seat(aiohttp_server):
    seen = {}

    async def handler(request):
        seen["token"] = request.headers.get("x-wopr-internal-token")
        seen["body"] = await request.json()
        return web.json_response({"chan": 7}, status=201)

    server = await _hub(aiohttp_server, handler)
    result = await place_seat_call(str(server.make_url("")), "s3cret", "HANDLE1")

    assert result == "placed"
    assert seen["token"] == "s3cret"
    # The hub discriminates on `seat` and ignores world/slot beside it. Sending
    # them would read as precision and be dead weight.
    assert seen["body"] == {"seat": "HANDLE1"}


@pytest.mark.asyncio
async def test_a_refusal_is_returned_not_raised(aiohttp_server):
    async def handler(request):
        return web.json_response({"refused": "seat-gone"}, status=409)

    server = await _hub(aiohttp_server, handler)
    assert await place_seat_call(str(server.make_url("")), "s3cret", "DEAD") == "seat-gone"


@pytest.mark.asyncio
async def test_an_unreachable_hub_is_returned_not_raised():
    # Port 9 discards: a connection that fails rather than one that answers.
    result = await place_seat_call("http://127.0.0.1:9", "s3cret", "HANDLE1")
    assert result != "placed"


@pytest.mark.asyncio
async def test_no_trunk_url_places_nothing():
    assert await place_seat_call("", "s3cret", "HANDLE1") == "no hub"
```

If `aiohttp` and its pytest plugin are not already dev dependencies of the node host, do **not** add them — instead read `emulator/node/tests/` for how existing tests stand up a stub HTTP server (`httpx`, `respx`, a `unittest.mock` patch of the client) and rewrite these four tests in that idiom. Adding a test dependency to satisfy a plan is a plan failure, not a design decision.

- [ ] **Step 2: Run to verify it fails**

Run: `cd emulator/node && python -m pytest tests/test_callback.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.callback'`.

- [ ] **Step 3: Write the module**

Create `emulator/node/app/callback.py`:

```python
"""Joshua placing a call.

The one place the bridge asks the relay for something. Everything else
between these two services runs the other way.

This function never raises. It is called from ws_session's `finally`, during
teardown, where the surrounding task may already be cancelled — so a failure
here must be a callback that does not happen, never a session that fails to
close.
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger("wopr.callback")


async def place_seat_call(trunk_url: str, internal_token: str, handle: str,
                          *, timeout_s: float = 5.0) -> str:
    """Ask the hub to ring `handle` on behalf of the flagship's own line.

    Returns "placed", or a refusal reason. Never raises.
    """
    if not trunk_url:
        # A monolith or a dev box with no hub. Not an error: there is simply
        # nobody to ask, and a machine with no trunk cannot call anyone.
        return "no hub"
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            # `seat` alone. The hub reads `want.seat !== undefined ? {seat}
            # : {slot, world}` and derives the placing end from its own
            # homeSlot, which is the entire reason this route exists.
            resp = await client.post(
                f"{trunk_url.rstrip('/')}/trunk/place",
                json={"seat": handle},
                headers={"x-wopr-internal-token": internal_token},
            )
    except Exception as exc:                      # noqa: BLE001 — see docstring
        log.warning("callback: could not reach the hub: %r", exc)
        return "unreachable"

    if resp.status_code == 201:
        return "placed"
    try:
        refused = str(resp.json().get("refused", "")) or f"http {resp.status_code}"
    except Exception:                             # noqa: BLE001
        refused = f"http {resp.status_code}"
    log.info("callback: the hub refused the call: %s", refused)
    return refused
```

Use whichever HTTP client the node host already depends on. `httpx` is written here because it is the common choice for an async FastAPI service; if `emulator/node/pyproject.toml` shows something else, use that instead and do not add a dependency.

The bare `except Exception` is deliberate and is the point of the module — see the docstring. Do not narrow it to a transport-error type: an unexpected exception escaping into `finally` is the failure mode this exists to prevent.

- [ ] **Step 4: Run the tests**

Run: `cd emulator/node && python -m pytest tests/test_callback.py -v`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add emulator/node/app/callback.py emulator/node/tests/test_callback.py
git commit -m "node: placing a call, and never raising while doing it"
```

---

### Task 6: The host records the seat handle

**Files:**
- Modify: `emulator/node/app/main.py:463-470` (the control branch)
- Test: `emulator/node/tests/test_session_intention.py` (create)

**Interfaces:**
- Consumes: the relay's `ORIGIN seat <handle>` control envelope (`emulator/relay/src/server.ts:532`).
- Produces: a local `seat_handle: str | None` inside `ws_session`, read by Task 7.

**What arrives:** two shapes, both pushed by the relay ahead of anything else on the session.
- `ORIGIN seat <handle>` — from a direct `/link` dial that carried `?seat=<token>`.
- `ORIGIN world <n> slot <SLOT>` — from `local-leg.ts:118`, when a *machine* called this program.

Only the first is a handle. The second is provenance, recorded for the event log and otherwise unused here.

**What must not change:** an unrecognized `ORIGIN` keeps falling through to the existing `continue`, so it stays invisible to the program. That is the current behaviour and it is load-bearing — a control frame that leaked into a period program's input would be read as a command.

- [ ] **Step 1: Write the failing test**

Create `emulator/node/tests/test_session_intention.py`. It drives the real websocket endpoint through FastAPI's test client, because what is being pinned is the *session coroutine's* behaviour:

```python
"""The seat handle in, the intention out, and the call at the hangup.

These tests are about WHEN a call is placed, not about HTTP — place_seat_call
is stubbed throughout. Task 5's tests own the request itself.
"""
import pytest

from app.joshua import FALKEN_DOSSIER


def test_origin_seat_records_the_handle(session_ws, placed_calls):
    """A handle disclosed at connect is the only way the host can ever ring
    this visitor back."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        assert FALKEN_DOSSIER in ws.receive_json()["payload"]
    assert placed_calls == ["HANDLE1"]


def test_origin_world_slot_is_not_a_handle(session_ws, placed_calls):
    """A machine calling in discloses where it called FROM. That is not a
    seat, and ringing it back would be ringing an exchange, not a person."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN world 1 slot PANAM"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    assert placed_calls == []


def test_an_unknown_origin_never_reaches_the_program(session_ws):
    """The existing drop, pinned. A control frame read as input is a control
    frame a period program will try to execute."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN something we do not know"))
        ws.send_json(user_input("HELLO"))
        reply = ws.receive_json()["payload"]
        assert "something we do not know" not in reply
```

You must write `session_ws`, `placed_calls`, `control` and `user_input` as fixtures/helpers. Read `emulator/node/tests/` first — there is existing websocket-session test machinery (the E0x eval scenarios and the router tests both drive sessions), and this must reuse it rather than build a parallel harness. `placed_calls` is a list that a monkeypatched `app.main.place_seat_call` appends its `handle` argument to.

- [ ] **Step 2: Run to verify it fails**

Run: `cd emulator/node && python -m pytest tests/test_session_intention.py -v`
Expected: FAIL — `placed_calls` is empty in the first test, because nothing reads `ORIGIN` or places anything yet.

- [ ] **Step 3: Add the `ORIGIN` branch**

In `emulator/node/app/main.py`, declare the local beside `pending` at `:380`:

```python
        pending: dict[str, str] = {}
        # Disclosed by the relay ahead of anything else on this session, and
        # the only way this host can ever ring this visitor back. A local,
        # not a registry: nothing outside this coroutine reads it, and it
        # must not outlive the session that was given it (spec §3).
        seat_handle: str | None = None
        called_from: str | None = None
```

Then extend the control branch at `:463`:

```python
                if kind == "control":
                    if message == "HANGUP":
                        await ws.close()
                        return
                    if message == "BREAK":
                        await store.log_event(session_id, "input", "user", {"control": "BREAK"})
                        await ws.send_text(envelope("output", "\n*** BREAK ***\n"))
                    elif message.startswith("ORIGIN seat "):
                        seat_handle = message[len("ORIGIN seat "):].strip() or None
                    elif message.startswith("ORIGIN world "):
                        # Provenance only: a machine called, and this says
                        # which slot it called from. Not a seat — ringing it
                        # back would ring an exchange, not a person.
                        called_from = message[len("ORIGIN "):].strip() or None
                    continue
```

Everything else still reaches the unconditional `continue`, so an unknown `ORIGIN` is dropped exactly as it is today.

- [ ] **Step 4: Run — the first test still fails, deliberately**

Run: `cd emulator/node && python -m pytest tests/test_session_intention.py -v`
Expected: `test_an_unknown_origin_never_reaches_the_program` PASSES; the other two still FAIL, because nothing places a call yet. That is Task 7. Do not implement it here.

- [ ] **Step 5: Commit**

```bash
git add emulator/node/app/main.py emulator/node/tests/test_session_intention.py
git commit -m "node: the host hears who it is talking to"
```

---

### Task 7: The intention, and the call at the hangup

**Files:**
- Modify: `emulator/node/app/main.py` (the turn loop, and the `finally` at `:530`)
- Test: `emulator/node/tests/test_session_intention.py` (extend)

**Interfaces:**
- Consumes: `RouteResult.seeks` (Task 3), `place_seat_call` (Task 5), `seat_handle` (Task 6), `settings.trunk_url` (Task 4).
- Produces: nothing further. This is the piece's terminal behaviour.

**The whole reason this is deferred to the hangup:** a seat on a call is held, and `ring()` refuses a held seat as `busy` (`emulator/relay/src/seats.ts:187`). The visitor is by definition on the call where the dossier was disclosed, so a call placed at the moment of intention is refused every single time. The hangup releases the hold. See spec §2 — this is the piece's central constraint and the reason the superseded spec's version of it could never have worked.

- [ ] **Step 1: Write the failing tests**

Append to `emulator/node/tests/test_session_intention.py`:

```python
def test_the_call_is_placed_at_the_hangup_not_at_the_dossier(session_ws, placed_calls):
    """A seat on a call is held, and a held seat is refused `busy`. Placing
    at the moment of intention would fail every time (spec §2)."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        assert FALKEN_DOSSIER in ws.receive_json()["payload"]
        assert placed_calls == [], "placed while the visitor was still on the line"
    assert placed_calls == ["HANDLE1"]


def test_no_intention_places_nothing(session_ws, placed_calls):
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("HELLO"))
        ws.receive_json()
    assert placed_calls == []


def test_no_handle_places_nothing(session_ws, placed_calls):
    """A visitor who dialled without a seat token cannot be rung back, and
    the intention is dropped rather than guessed at."""
    with session_ws() as ws:
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    assert placed_calls == []


def test_the_intention_is_a_latch_not_a_counter(session_ws, placed_calls):
    """Two dossier disclosures in one session are one intention. A machine
    that rings twice for one decision is a machine with a bug."""
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        for _ in range(2):
            ws.send_json(user_input("IS FALKEN DEAD?"))
            ws.receive_json()
    assert placed_calls == ["HANDLE1"]


def test_a_refusal_does_not_break_the_hangup(session_ws, placed_calls, refuse_calls):
    """The callback runs in `finally`, during teardown. A failure there must
    be a callback that did not happen, never a session that did not close."""
    refuse_calls(RuntimeError("hub exploded"))
    with session_ws() as ws:
        ws.send_json(control("ORIGIN seat HANDLE1"))
        ws.send_json(user_input("JOSHUA"))
        ws.receive_json()
        ws.send_json(user_input("IS FALKEN DEAD?"))
        ws.receive_json()
    # Reaching here at all is the assertion: the context manager exited
    # cleanly rather than propagating out of the disconnect path.
```

`refuse_calls` is a fixture that makes the monkeypatched `place_seat_call` raise. Note this deliberately tests the belt on top of Task 5's braces: `place_seat_call` already promises never to raise, and Task 7 must still not depend on that promise, because a future edit to Task 5's module must not be able to break session teardown.

- [ ] **Step 2: Run to verify they fail**

Run: `cd emulator/node && python -m pytest tests/test_session_intention.py -v`
Expected: the four handle/intention tests FAIL (`placed_calls` empty, or the latch test seeing two entries once a naive implementation lands).

- [ ] **Step 3: Record the intention in the turn loop**

Beside the other locals at `:380`:

```python
        # A latch, not a counter: the machine decided once. Set where the
        # turn result is read, acted on at the hangup, and — being a local —
        # incapable of outliving the session that formed it.
        seeks: str | None = None
```

Then, wherever the Joshua turn's `RouteResult` is available in the loop (read the surrounding code; the router call is the one that produces `result`), latch it:

```python
                if result.seeks and seeks is None:
                    seeks = result.seeks
```

- [ ] **Step 4: Place the call in `finally`**

Extend the `finally` at `emulator/node/app/main.py:530`:

```python
        finally:
            if observer_task is not None:
                observer_task.cancel()
            # The hangup IS the trigger to dial. Until this moment the
            # visitor held their own seat, and a held seat is refused `busy`
            # (relay/src/seats.ts:187) — so this is the first instant the
            # call can succeed, and the last instant the handle is still
            # worth anything.
            if seeks and seat_handle:
                try:
                    outcome = await place_seat_call(
                        settings.trunk_url, settings.internal_token, seat_handle)
                except Exception as exc:            # noqa: BLE001
                    # place_seat_call promises never to raise. Not depending
                    # on that promise: an exception escaping here does not
                    # fail a callback, it fails the disconnect.
                    log.warning("callback: placement raised: %r", exc)
                else:
                    log.info("callback: %s -> %s", seeks, outcome)
```

Add `from .callback import place_seat_call` to the imports.

**Do not `await` this without a bound.** `place_seat_call` carries its own 5-second timeout, which is what keeps this from holding a teardown open. Do not add a second timeout here, and do not spawn it as a background task — a task created during teardown has nothing left to keep it alive and will be cancelled before it sends anything.

- [ ] **Step 5: Run the tests**

Run: `cd emulator/node && python -m pytest tests/test_session_intention.py -v`
Expected: PASS, 8 tests.

- [ ] **Step 6: Run the whole node suite**

Run: `cd emulator/node && python -m pytest -q`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add emulator/node/app/main.py emulator/node/tests/test_session_intention.py
git commit -m "node: Joshua calls back when the line goes quiet"
```

---

### Task 8: `WoprSeat` — a client that can be rung

**Files:**
- Create: `emulator/web/crt-kit/src/seat.ts`
- Modify: `emulator/web/crt-kit/src/link.ts:23-29` (`WoprLinkOpts`), `:53-58` (URL construction)
- Modify: `emulator/web/crt-kit/src/index.ts` (export the new class and its event type)
- Test: `emulator/web/crt-kit/tests/seat.test.mjs` (create)

**Interfaces:**
- Consumes: the hub's `/seat` wire — send `control` `SEAT?`, receive `control` `SEAT <token>`, receive `control` `RING <name>`, send `control` `ANSWER` / `REJECT` (`emulator/relay/src/server.ts:795-836`).
- Produces:
  - `WoprLinkOpts.seat?: string` — appended as `&seat=<token>` when present.
  - `class WoprSeat { constructor(opts: { url?: string; surface: string }); onEvent(fn: (e: SeatEvent) => void): () => void; connect(): void; answer(): void; reject(): void; close(): void; get token(): string | undefined }`
  - `type SeatEvent = { type: "seated"; token: string } | { type: "ring"; from: string } | { type: "frame"; frame: Envelope } | { type: "close" }`

  Task 9 consumes all of it.

**Why crt-kit and not `emulator/terminal/`:** the spec §6 says `emulator/terminal/src/`, and that is wrong — `emulator/terminal/` is the xterm/TTY terminal package, and `WoprLink`, the thing this mirrors, lives in `emulator/web/crt-kit/src/link.ts` and is exported as `@real-wopr/crt-kit`. crt-kit is the shared web kit both surfaces already mount, which is what makes it the right home for a seat piece C will extend.

**Why the handshake is causal:** the hub mints and sends `SEAT <token>` only in reply to a client `SEAT?`. Do not connect and wait for an unsolicited token — the hub sends none, and there is a 20-second timer that closes 4408 on a socket that never handshakes.

- [ ] **Step 1: Write the failing tests**

Create `emulator/web/crt-kit/tests/seat.test.mjs`, following `tests/link.test.mjs`'s `withFakeSocket(t)` idiom exactly — copy that helper rather than inventing a second fake:

```javascript
// A seat is the thing a machine can ring. It is NOT a call: it outlives every
// call the terminal makes, which is the whole reason a callback can arrive
// after the visitor hangs up (spec §2).

import test from "node:test";
import assert from "node:assert/strict";
import { WoprSeat } from "../src/seat.ts";

// ... withFakeSocket(t) copied from link.test.mjs ...

const control = (payload) => JSON.stringify({
  v: 1, session: "x", seq: 0, kind: "control", link: "seat", payload, eom: true,
});

test("a seat asks for its token — the hub never volunteers one", (t) => {
  const made = withFakeSocket(t);
  new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" }).connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  const sent = ws.sent.map((s) => JSON.parse(s).payload);
  assert.deepEqual(sent, ["SEAT?"],
    "send-on-connect is unimplementable hub-side; the client must ask");
});

test("the surface rides on the URL", (t) => {
  const made = withFakeSocket(t);
  new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" }).connect();
  assert.match(made[0].url, /surface=home-terminal/);
});

test("the token is kept, and a ring is announced", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  assert.equal(seat.token, "TOK1");
  ws.onmessage?.({ data: control("RING CHEYENNE MOUNTAIN") });
  assert.deepEqual(events, [
    { type: "seated", token: "TOK1" },
    { type: "ring", from: "CHEYENNE MOUNTAIN" },
  ]);
});

test("answering and declining each send one control frame", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.sent.length = 0;
  seat.answer();
  seat.reject();
  assert.deepEqual(ws.sent.map((s) => JSON.parse(s).payload), ["ANSWER", "REJECT"]);
});

test("after answering, ordinary frames are delivered as frames", (t) => {
  const made = withFakeSocket(t);
  const seat = new WoprSeat({ url: "ws://h/seat", surface: "home-terminal" });
  const events = [];
  seat.onEvent((e) => events.push(e));
  seat.connect();
  const ws = made[0];
  ws.readyState = 1;
  ws.onopen?.();
  ws.onmessage?.({ data: control("SEAT TOK1") });
  ws.onmessage?.({ data: JSON.stringify({
    v: 1, session: "x", seq: 1, kind: "output",
    payload: "GREETINGS PROFESSOR FALKEN.", eom: true }) });
  assert.equal(events.at(-1).type, "frame");
  assert.equal(events.at(-1).frame.payload, "GREETINGS PROFESSOR FALKEN.");
});
```

Add one more, pinning the `WoprLink` change:

```javascript
test("a link carries the seat token, so the hub knows who to mint for", (t) => {
  const made = withFakeSocket(t);
  new WoprLink({ url: "ws://h/link", surface: "home-terminal",
                 session: "s", token: "t", seat: "TOK1" }).connect();
  assert.match(made[0].url, /seat=TOK1/);
});
```

Import `WoprLink` alongside `WoprSeat` for it.

- [ ] **Step 2: Run to verify they fail**

Run: `cd emulator/web/crt-kit && npm test`
Expected: FAIL — `Cannot find module '../src/seat.ts'`.

- [ ] **Step 3: Add the `seat` option to `WoprLink`**

In `emulator/web/crt-kit/src/link.ts`, extend `WoprLinkOpts` at `:23`:

```typescript
  token?: string;
  /** This terminal's seat token, when it holds one. Presenting it is what
   *  makes the hub mint a capability handle for this visitor and disclose it
   *  to the program (relay/src/server.ts:508). Without it the visitor can
   *  dial out and can never be rung back. */
  seat?: string;
```

and in `connect()` after the token line at `:57`:

```typescript
    if (this.opts.seat) url.searchParams.set("seat", this.opts.seat);
```

- [ ] **Step 4: Write `WoprSeat`**

Create `emulator/web/crt-kit/src/seat.ts`. Mirror `link.ts`'s structure — same listener set, same emit helper, same dependency-free style. Points the implementation must get right:

- The URL default mirrors `link.ts`'s: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/seat`.
- `SEAT?` is sent from `onopen`, not from the constructor.
- Envelope encoding matches `link.ts`'s exactly. Read how it builds and sends a control envelope and reuse that shape; do not hand-roll a second one.
- `SEAT <token>` sets `token` and emits `seated`. `RING <name>` emits `ring` with everything after `RING ` as `from` — a name contains spaces (`CHEYENNE MOUNTAIN`), so split once, not on every space.
- Any other `control` payload is ignored. Every non-`control` envelope is emitted as `frame`.
- `answer()` and `reject()` are no-ops before a token exists — there is nothing to answer yet, and the hub ignores them anyway (`if (id === undefined) return`).
- `close()` closes the socket. A closed seat is a seat that cannot be rung; that is correct and needs no other cleanup, because the hub reaps the leg and every handle minted against it.

- [ ] **Step 5: Export from the package**

Add to `emulator/web/crt-kit/src/index.ts`, following the existing export style:

```typescript
export { WoprSeat, type SeatEvent } from "./seat.ts";
```

- [ ] **Step 6: Run the tests**

Run: `cd emulator/web/crt-kit && npm test`
Expected: PASS — the 6 new tests plus every existing one.

- [ ] **Step 7: Commit**

```bash
git add emulator/web/crt-kit/src/seat.ts emulator/web/crt-kit/src/link.ts \
        emulator/web/crt-kit/src/index.ts emulator/web/crt-kit/tests/seat.test.mjs
git commit -m "crt-kit: a terminal that can be rung"
```

---

### Task 9: David's desk holds a seat

**Files:**
- Modify: `emulator/web/home-terminal/app/page.tsx:82` (a ref), `:310-318` (the dial), plus a new seat effect and ring handler
- Modify: `emulator/terminal/src/frames.ts:34` (`Phase` gains `"ringing"`)
- Test: covered by `emulator/web/home-terminal`'s existing suite. `page.tsx` is a large React component with no unit-test seam today; **do not restructure it to create one** — Task 8 is where the seat's behaviour is pinned, and this task is wiring. If the package has a component-test setup already, add a ring-renders test; if it does not, adding a test framework is out of scope for this plan.

**Interfaces:**
- Consumes: `WoprSeat`, `SeatEvent`, `WoprLinkOpts.seat` from Task 8.
- Produces: the end of the piece. Nothing consumes this.

**Screen ownership needs no arbitration**, and this is the reason: a terminal on a call holds its own seat (`server.ts:522`), and `ring()` refuses a held seat as `busy` (`seats.ts:187`). A ring can therefore only arrive when the terminal is at its command prompt. Do not add a guard for "ringing while on a call" — it cannot happen, and a guard would imply it can.

- [ ] **Step 1: Hold one seat for the life of the page**

In `emulator/web/home-terminal/app/page.tsx`, add a ref beside `link` at `:82`:

```typescript
  const link = useRef<WoprLink | null>(null);
  // ONE seat for the life of the terminal, not one per call. This is the
  // whole reason a callback can arrive after the visitor hangs up: the call
  // ends, the seat does not (spec §2).
  const seat = useRef<WoprSeat | null>(null);
```

and an effect that constructs it exactly once — **not** inside the dial effect, which runs per call:

```typescript
  useEffect(() => {
    if (seat.current) return;
    const base = process.env.NEXT_PUBLIC_COMMS_URL;
    const s = new WoprSeat({
      // Same comms layer the dial reaches, different endpoint. `surface`
      // decides the profile an answered ring is paced at, so this is also
      // what makes a callback arrive at the home terminal's own 600 baud.
      url: base ? base.replace(/\/link$/, "/seat") : undefined,
      surface: "home-terminal",
    });
    s.onEvent(onSeatEvent);
    s.connect();
    seat.current = s;
    return () => { s.close(); seat.current = null; };
  }, [onSeatEvent]);
```

`onSeatEvent` is the handler written in Step 3. Import `WoprSeat` from `@real-wopr/crt-kit` alongside the existing `WoprLink` import.

- [ ] **Step 2: Pass the token into the dial**

At `:312`, the `WoprLink` construction gains one line:

```typescript
      link.current = new WoprLink({
        url: exchange?.link ?? process.env.NEXT_PUBLIC_COMMS_URL,
        surface: "home-terminal",
        session: s.session_id,
        token: s.token,
        seat: seat.current?.token,   // absent until the seat handshake lands
      });
```

`seat` being `undefined` on an early dial is acceptable and must not be waited for: the terminal stays fully usable, the visitor simply cannot be rung back from that particular call. Do not block the dial on the seat handshake.

- [ ] **Step 3: Render the ring**

Add the handler, using the same `appendText` (`:122`) and `setPhase` (`:78`) the rest of the terminal uses:

```typescript
  const onSeatEvent = useCallback((e: SeatEvent) => {
    if (e.type === "ring") {
      // A ring can only arrive at the command prompt: a terminal on a call
      // holds its own seat, and the hub refuses to ring a held seat as busy
      // (relay/src/seats.ts:187). No guard is needed for "ringing mid-call",
      // and adding one would imply it can happen.
      appendText(`\n\nRING\n${e.from} IS CALLING.\nANSWER? (Y/N)\n`);
      setPhase("ringing");
      return;
    }
    if (e.type === "frame") {
      frames.current?.onEvent({ type: "frame", frame: e.frame });
      return;
    }
    if (e.type === "close") setPhase("idle");
  }, [appendText, setPhase]);
```

`frames.current` is the existing `HomeFrameHandler` (`page.tsx:131`), whose method is
`onEvent(e: FrameEvent)` (`emulator/terminal/src/frames.ts:98`). `FrameEvent`'s frame case
is `{ type: "frame"; frame: LinkFrame }`, the same shape `SeatEvent` carries — an answered
seat delivers ordinary paced envelopes, so it renders through the path that already exists
rather than a second one. If the two envelope types are not structurally identical, convert
at this call site; do not widen `HomeFrameHandler`.

Add `"ringing"` to the `Phase` union. **That union lives in `emulator/terminal/src/frames.ts:34`**, not in the web package — a second file this task modifies, and one whose package has its own CI job. Then handle the two keystrokes wherever the surface already dispatches keys at a prompt (read `console.ts` — do not add a parallel key path):

- `Y` → `seat.current?.answer()`, then `setPhase` to whatever phase an active conversation uses.
- `N` → `seat.current?.reject()`, then `setPhase("idle")`.
- anything else, or nothing at all → ignored. The hub's 30-second ring timeout ends it on its own, which is a supported outcome, not a leak.

- [ ] **Step 4: Run the web suite**

Run: `cd emulator/web && npm test` (or this package's own script — read `package.json`)
Expected: PASS.

- [ ] **Step 5: Run the terminal and web CI jobs locally**

Run: `cd emulator/terminal && npm test` and `cd emulator/web/crt-kit && npm test`
Expected: PASS both. These are two of the nine required checks.

- [ ] **Step 6: Commit**

```bash
git add emulator/web/home-terminal/app/page.tsx
git commit -m "home terminal: the phone can ring"
```

---

### Task 10: Full-suite verification and the PR

**Files:** none — this task changes no source.

**Interfaces:**
- Consumes: every preceding task.
- Produces: a merged PR in the pack.

- [ ] **Step 1: Run everything the nine CI checks run**

```bash
make build
make test
tools/behavior.sh
cd emulator/node && python -m pytest -q
cd emulator/relay && npm test && npm run typecheck
cd emulator/web/crt-kit && npm test
cd emulator/terminal && npm test
```

Expected: all green. The golden fixture count changes by zero — Task 1 edited one fixture's *content*, not the count. If any other fixture changed, something drifted between the two deterministic engines and it must be understood, not regenerated.

- [ ] **Step 2: Open the PR**

```bash
git push -u origin claude/joshua-intention
gh pr create --title "Joshua calls back" --body "..."
```

The body should lead with the constraint from spec §2 — that a busy seat cannot be rung, so the hangup is the trigger — because that is the non-obvious decision a reviewer most needs to evaluate.

- [ ] **Step 3: Merge once CI is green**

```bash
gh pr merge --squash
```

Squash only. `--merge` fails on this repo.

---

## Follow-on work, in the engine repo — NOT part of this plan's branch

These land in `../real-wopr`, a **different Tier A repo** with different rules and its own CI (one job, `evals`). They need their own worktree, branch and PR. **Ignore this pack's `AGENTS.md` when working there** — its contribution rules and required checks do not apply.

1. **Re-pin** `packs.lock` to the squashed pack commit, run the evals, and add a `HANDOFF.md` entry.
2. **The compose change**, in `../homelab` (Tier C — direct push to `main`, and note that `apps/wopr/**` has no deploy workflow, so wopr deploys only via the manual `deploy.sh`): add `BRIDGE_TRUNK_URL: http://comms:8081` to the bridge service's environment. Without it the host forms intentions and places nothing.
3. **The eval scenario** covering the callback, added after the re-pin so it runs against the new pack. It is deterministic because the dossier beat is.
4. **The owner step that is still outstanding from piece B**: the Cloudflare tunnel's ingress rules are an allowlist and `/seat*` is not in it, so no browser can hold a seat until a dashboard rule routes it to `http://comms:8081`. Piece D is not observable end-to-end in production until that exists. See `homelab/apps/wopr/GO-LIVE.md`.
