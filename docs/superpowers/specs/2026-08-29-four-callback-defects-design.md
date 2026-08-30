# Four callback defects — design

Date: 2026-08-29
Status: approved (design, spec and implementation pre-approved by Daniel)
Issue: [real-wopr-programs#78](https://github.com/DanielLandi/real-wopr-programs/issues/78)

Four small, independent, user-visible defects promoted out of the deferred-minor
lists (#71, #77). Three of them are on the callback path Worlds phase 2 built —
the seat that can be rung, the ring that can be declined, the provenance event
that records who rang — and the fourth is the reason none of that path's Claude
half has been exercised since the day it was written.

They land as four commits on one branch. Nothing here is coupled: each commit
reverts on its own.

---

## 1. `WoprSeat` has no reconnect

### The mechanism

`emulator/web/crt-kit/src/seat.ts` opens one `/seat` socket, asks for a token
(`SEAT?`), keeps the token the hub replies with, and — on `onclose` — emits
`{type:"close"}` and stops. There is no second attempt, ever, for the life of
the page.

The seat's own header says *"a seat outlives every call the terminal itself
makes as a visitor: that is the whole point"*. It does not outlive its socket.

What the visitor sees is the problem. `page.tsx` reads `seat.current?.token` at
dial time and passes it to `WoprLink` as `seat:`. After a drop the `WoprSeat`
object is still there and still holds `_token`, so every later dial keeps
presenting a token minted against a leg the hub has already reaped. The mint is
refused (#70), the visitor is never told, the dial succeeds anyway, and the call
is simply one that can never be rung back. The feature stops working and nothing
on the screen changes.

Two ordinary events produce this: a tunnel blip, and an exchange redeploy. The
exchange redeploys.

**Verified against the code**: the issue is right in every particular.
`connect()` is called exactly once (the `useEffect` at `page.tsx:210` guards on
`if (seat.current) return`), `onclose` only emits, and `_token` is assigned in
one place and never cleared.

One thing the issue does not say, which matters for the fix: `WoprLink` itself
has no reconnect either. The redial story it is part of lives one layer up — the
home terminal's `dial()` (`isOpen()`, then a control `DIAL` on a live line, else
mint-and-connect afresh, #27), its `mintSession` (one retry, `LINE BUSY -
RETRYING`, #93), and the NORAD console's `NoradFrameHandler`
(`scheduleReconnect` / `scheduleRedial`, a bounded budget cleared by a live
handshake, `norad-terminal/app/page.tsx:108`). The design below reuses the
*shape* of that story rather than inventing a second one; where it differs from
NORAD's, decision 3 says why.

### Decisions

1. **A dropped socket clears the token immediately, before anything else.**
   `_token`, `legId` and `seq` are reset inside `onclose`. This is the half of
   the fix that matters even if every reconnect attempt fails: a seat with no
   token makes `page.tsx`'s `seat: seat.current?.token` evaluate to `undefined`,
   the `seat=` query parameter is omitted, and the visitor dials a call that is
   honestly not ringable — instead of one that claims to be and is not. A stale
   token is strictly worse than no token: it costs a refused mint at the far end
   and buys nothing.

2. **A reconnect is a full re-handshake, not a resumption.** `connect()` already
   sends `SEAT?` on open and the hub answers with a *new* token and a new leg
   id; there is no resume verb in the `/seat` vocabulary and adding one would
   mean the hub keeping reaped legs alive on the chance a browser comes back.
   So a reconnect is exactly the code path a first connect takes. Consequence,
   stated plainly: **a seat's token is not stable across a drop**, and anything
   that caches one is wrong. Nothing does — `page.tsx` reads it fresh per dial.

3. **Backoff: 750 ms, doubling, capped at 30 s, attempted indefinitely.**
   - 750 ms is the NORAD console's first delay
     (`norad-terminal/app/page.tsx:109`), reused so the two reconnects start at
     the same number rather than at two arbitrary ones.
   - Doubling, where NORAD's is flat, because NORAD retries at most three times
     against a leased line that is supposed to be up; a seat retries against an
     exchange that may be mid-redeploy, and a flat 750 ms for minutes is a poll,
     not a backoff.
   - **The attempt count is not capped**, which is the one place this
     deliberately differs from NORAD's budget of three. NORAD gives up into a
     visible `down` phase that the operator can see; a seat has no visible
     state at all, so "gave up" would be indistinguishable from the bug this
     change fixes. The cap is on the *interval*, not the attempts: a page left
     open against a dead exchange re-dials the seat every 30 s and costs one
     failed WebSocket handshake per half-minute.
   - **No jitter.** A redeploy does reconnect every open page at once, but the
     population is a handful of browsers, not a fleet, and jitter would make the
     schedule untestable without injecting a clock into a class whose whole
     virtue is that it is dependency-free. Recorded here as a known,
     deliberately unfixed sharp edge rather than hidden.

4. **The backoff resets on a `SEAT` reply, not on `onopen`.** A socket that
   opens and is then closed by the hub's own 4408 handshake timer is not a
   working seat; resetting on open would turn that case into a 750 ms poll
   forever. The token is the only proof the seat works. This mirrors
   `NoradFrameHandler`, which clears its retry budget on a live `CONNECTED`
   handshake rather than on the socket coming up.

5. **`{type:"close"}` is still emitted on every drop, before the reconnect is
   scheduled.** A reconnect repairs the seat, not the call that was riding it:
   if the visitor was mid-ring or on an answered callback, that call really is
   over and `page.tsx`'s existing close handler must still return the screen to
   the prompt. Suppressing `close` for "blips we are about to repair" would
   strand a visitor on a dead conversation.

6. **An explicit `close()` never reconnects, and cancels a pending attempt.**
   `close()` is the page unmounting. A `closed` latch guards the scheduler and
   the pending timer is cleared, so a torn-down component leaves no timer
   behind. `connect()` clears the latch, so a seat can be deliberately reopened.

7. **The visitor sees nothing.** No new sink, no new line on the screen, no new
   phase. A seat is plumbing: the terminal has no 1983 vocabulary for "the thing
   that lets a machine ring you has been re-established", and inventing one
   would put a modern concept on a period screen. The only visitor-visible
   consequence is the one that already exists — a call that was riding the seat
   ends.

8. **A dial during the reconnect window gets no seat handle, and that is
   correct.** It is a call that cannot be rung back, and the next dial after the
   seat re-seats can be. Blocking or delaying a dial until the seat is back
   would make a seat blip break dialling out, which is the larger feature.
   Documented, not fixed.

### What pins it

`emulator/web/crt-kit/tests/seat.test.mjs`, using `node:test`'s `mock.timers` so
the schedule is asserted rather than waited on:

- a dropped socket clears the token (the stale-token half, on its own)
- a dropped socket re-opens after 750 ms and re-sends `SEAT?` on the new socket
- the delays double and cap: 750, 1500, 3000 … 30000, 30000
- a `SEAT` reply resets the schedule — the next drop waits 750 ms again
- a socket that opens but never seats does **not** reset the schedule
- an explicit `close()` schedules nothing, and cancels an attempt already pending
- the second seating replaces the token with the new one

---

## 2. Declining a ring prints `NO CARRIER`

### The mechanism

`emulator/relay/src/server.ts`'s `seatBridge.ring` funnels every exit from a
ring or call through one `end(reason, playOut)`, and `playOut` is true for all
of them except "the seat itself went away". `playOutAndDrop` then sends a
control `NO CARRIER` down the seat leg. `HomeFrameHandler` renders that as
`\n\nNO CARRIER\n` and moves the phase to `no-carrier`.

So a visitor who types `N` at `ANSWER? (Y/N)` is told the carrier dropped on a
call that never had one. Wrong in the fiction, and wrong on the wire: `NO
CARRIER` is a Hayes result code for a connection that existed and stopped.

**Verified, with one correction to the issue.** The issue frames this as the
decline path only. In the code the same `end()` serves four unanswered exits —
`rejected`, `timedOut`, the caller hanging up mid-ring, and `greeting exceeds
hold capacity` — and all four send `NO CARRIER` today. Two existing tests assert
it (`server.test.ts`, "a caller that hangs up mid-ring disarms the ring" and "a
caller that floods an unanswered line is hung up on"). The fix has to cover all
four or it fixes the rarest one.

The second thing the code says that the issue does not: **the wire word cannot
simply be deleted.** The seat socket stays open across a call by design, so it
never closes to signal anything. `NO CARRIER` is currently the *only* thing that
tells a terminal sitting at `ANSWER? (Y/N)` that a ring it never answered is
over. Remove it and a timed-out or abandoned ring leaves the visitor at a dead
Y/N prompt forever. Something has to take its place.

### Decisions

1. **A new control word, `NO ANSWER`, for every ring that did not become a
   call.** Hayes result code, so it is period-exact; the honest complement of
   `NO CARRIER` for a line that never carried; and it is already the reason
   string `end("no answer")` puts on the upstream `CLOSE`, so the wire word and
   the log line now agree. It collides with neither of the seat's existing
   prefixes (`SEAT `, `RING `) — which `RING OFF` or `RING END` would have,
   parsing as a ring from a machine called `OFF`.

2. **The hub does not branch on *why* the ring ended.** `answered` is the whole
   test: `NO CARRIER` if a call existed, `NO ANSWER` if it did not. The hub
   cannot usefully distinguish "you declined" from "you never picked up" in
   terms of what carried, and the visitor who declined already knows they
   declined.

3. **`NO ANSWER` is the seat client's own vocabulary, not a forwarded frame.**
   `WoprSeat` gains a branch beside `SEAT` and `RING` and emits a new
   `{type:"ring-ended"}` event instead of forwarding. This is the exception the
   seat's own header comment argues for and against: it argues against
   hardcoding `NO CARRIER` there, because the meaning of a carrier drop belongs
   to the frame handler — but `RING`/`NO ANSWER` are two halves of the seat
   handshake, and the arm is already parsed here. Splitting the pair across two
   modules would be the drift.

4. **Nothing is printed, for any ring that did not become a call.** This is what
   the issue asks for and it is also what a telephone does: it rings, you do not
   pick up, it stops ringing, and there is no announcement. The `RING /
   <NAME> IS CALLING.` lines stay in the scrollback as the record that the phone
   rang, the decliner's own `> N` echo is the record of what they did, and the
   prompt coming back is the signal. `ring-ended` moves the phase to `idle` —
   not to `no-carrier`, which would keep claiming a line that never existed.

5. **`HomeFrameHandler` is not touched.** It never sees `NO ANSWER` (decision 3)
   and its `NO CARRIER` handling is still exactly right for an answered call
   that ends. A change there would be a change to the dialled path, which has no
   defect.

### What pins it

Relay (`emulator/relay/tests/server.test.ts`):

- a declined ring: the seat is sent `NO ANSWER`, and never `NO CARRIER` (new)
- an answered call that ends still sends `NO CARRIER` (existing, unchanged — the
  regression this must not cause)
- the two existing unanswered-exit tests, updated to `NO ANSWER`, with their
  original assertions about the seat going free left intact

crt-kit (`emulator/web/crt-kit/tests/seat.test.mjs`):

- `NO ANSWER` becomes one `ring-ended` event and is **not** forwarded as a frame
- `NO CARRIER` is still forwarded as a frame, unparsed (existing test, unchanged)

**Not pinned, and named rather than hidden:** the three-line change in
`page.tsx`'s `onSeatEvent`. The web workspace has no React test harness — its
`npm test` runs `node --test` over plain `.mjs` modules — so no component
behaviour in that file is under test today, and standing one up for three lines
is a larger change than the defect. The wire and the client are both pinned; the
wiring between them is not.

---

## 3. `EVENTS` renders the provenance event with a blank summary

### The mechanism

`emulator/node/app/router.py`'s `_events` builds each line's summary by taking
the first key of `("text", "route", "defcon", "game", "system")` that appears in
the event payload. `main.py:594` logs the machine-call provenance event as
`{"origin": "world 1 slot PANAM"}` — a payload with exactly one key, and that
key is not in the list. So the row renders as `ROUTE   SYSTEM  ` with an empty
summary column: the event that records *who called* is the one event an operator
cannot read.

**Verified**: exactly as the issue describes. One key.

### Decisions

1. **`"origin"` is appended to the end of the tuple, not inserted.** The tuple is
   a precedence order, and the origin payload has no other key today — but
   appending guarantees that a future payload carrying both `origin` and, say,
   `route` still summarises by `route`, so no existing row's rendering can change
   as a side effect of this fix.

### What pins it

`emulator/node/tests/test_router.py`: log an origin-shaped event and assert
`EVENTS` renders `ORIGIN WORLD 1 SLOT PANAM` on its row — the value, not just a
non-empty column.

---

## 4. The Claude engine's callback contribution is not exercised by CI

### The mechanism

`anthropic` is declared only in the `prod` extra of `emulator/node/pyproject.toml`.
The `node` CI job runs `pip install -e "emulator/node[dev]"`. Both
`tests/test_joshua_claude.py` and `tests/test_joshua_claude_seeks.py` open with a
module-level `pytest.importorskip("anthropic")`, so both modules skip on every
CI run — five tests, including the two that pin `seek_falken` reaching
`JoshuaReply.seeks`, which is the Claude engine's entire contribution to the
callback.

**Verified locally against the same install CI uses:**

```
$ .venv/bin/python -m pytest tests/test_joshua_claude_seeks.py tests/test_joshua_claude.py -q
2 skipped in 0.01s
```

A green suite is reporting coverage it does not have. The issue is right that
this is worse than an absent test, and right that #76 is the same class of gap
one layer up.

### Decisions

1. **Both, not either — install the extra *and* make a missing extra loud.**
   The issue offers the two as alternatives. Installing the extra fixes today;
   only the loud half keeps it fixed, because the failure mode is silent by
   construction. Someone trimming the CI install line back to `[dev]` for build
   time would get a green run and no signal, which is precisely how this shipped
   the first time.

2. **The `node` job installs `[dev,prod]`.** Not "move `anthropic` into `dev`":
   the extras mean something — `dev` is what a contributor needs to run the
   suite, `prod` is what the deployed image installs — and moving a production
   client into `dev` to fix a CI gap would make `pyproject.toml` lie about both.
   `[dev,prod]` says what is true: this job wants the whole thing. `asyncpg`
   appears in both extras and is already installed, so the marginal cost is the
   `anthropic` wheel.

3. **The loud half is one `pytest_configure` guard in a new
   `emulator/node/tests/conftest.py`, gated on `WOPR_REQUIRE_PROD_EXTRAS=1`.**
   When the flag is set and `anthropic` or `asyncpg` is not importable, the
   suite fails at configure time with a `UsageError` naming the module and the
   install line — before a single test runs, so it cannot be mistaken for a test
   failure or lost in a scroll of dots. It is one place rather than a copy in
   each skipping module, it needs no change to the two test files, and with the
   flag unset (every local run, every other CI job) behaviour is exactly as it
   is today.

   The flag is opt-in rather than default-on because a contributor running
   `pytest` after `pip install -e '.[dev]'` should get the documented skip, not
   a hard failure for a production client they have no reason to install.

4. **A test asserts the CI job still does both.** `test_ci_extras.py` parses
   `.github/workflows/ci.yml`, finds the `node` job, and asserts its install
   step names the `prod` extra and that the job sets `WOPR_REQUIRE_PROD_EXTRAS`.
   This is the assertion that survives the revert in decision 1: trim the
   install line and CI fails in the suite, not silently in the skip. It parses
   with `yaml`, which arrives with `uvicorn[standard]` — a hard dependency of
   the package, so it is present in any install that can run the suite at all.

5. **`devkit` and `federation` are left on `[dev]`.** Neither runs these
   modules, and widening their installs would buy nothing but build time.

### What pins it

- `emulator/node/tests/test_ci_extras.py` — the two structural assertions above.
- The guard itself, exercised by running the node suite locally both ways: with
  `anthropic` absent and the flag set (must fail loudly, naming the module), and
  with `anthropic` installed and the flag set (the five Claude tests must run,
  by name, not skip).

---

## Determinism and the program/harness line

No program, golden fixture or wire protocol *format* changes here. Item 2 adds
one control word to the `/seat` leg's control vocabulary, which is harness-to-
harness; no period program sees it, and `STATE` is untouched. Items 1 and 4
touch only the modern harness and CI. Nothing reads a wall clock for a decision:
item 1's backoff is a fixed schedule, asserted through mocked timers rather than
elapsed time.
