# The relay paces a session by the surface the bridge stored — design

Date: 2026-08-29
Status: approved (design, spec and implementation pre-approved by Daniel)
Issue: [real-wopr-programs#80](https://github.com/DanielLandi/real-wopr-programs/issues/80)
Sequel to: [`2026-08-29-trunk-surface-auth-design.md`](./2026-08-29-trunk-surface-auth-design.md)
(#74 / PR #79), whose closing section names this exact hole and leaves it open.

`/link` takes its surface from the query string. The relay resolves a pacing
profile from that string and never asks the bridge what surface the session
actually is. Make the **stored** surface the authority: the relay looks it up
before it paces anything, and a query string that disagrees is refused rather
than honoured or quietly corrected.

## The hole, stated exactly

#79 closed the mint: `POST /api/session` now requires
`x-wopr-internal-token` for `trunk-call` and `trunk-caller`, so nobody can
*create* a machine-surface session from a browser. Nothing closed the dial. A
visitor mints an ordinary `home-terminal` session — no token required, by
design, that is the front door — and then dials

```
/link?surface=trunk-caller&session=<id>&token=<token>
```

`resolveLink(config, "trunk-caller")` returns profile `off` (baud 0, handshake
`none`), and both `LinkShaper`s for that leg are built from it. The session the
bridge sees is still `home-terminal`.

Two things are **not** exposed, and both matter for scoping:

- **The backdoor is not reachable this way.** `main.py`'s WS handler greets
  through `Router.open_backdoor` only when `session.surface == "trunk-caller"`,
  and `session` is read from the store. A visitor pulling this trick still gets
  `LOGON:`. #79 is what makes that true, and it stays true.
- **The `link` field a surface sees changes, but nothing downstream reads it as
  authority.** The bridge stamps its own `link_profile` from the session row.

What leaks is the **output pacing**: profile `off` bypasses the only
server-side shaping there is, which for the `claude` engine is also the only
thing bounding token spend per connection.

### How much this is worth, honestly

Less than the issue's framing implies, and the difference is worth writing down
because it decides what this change may claim.

`norad-bigboard` and `wopr-panel` resolve to `internal-bus`, which is
**`baud: 0`** — uncapped, handshake `none` — and both mint with no token at
all. An unpaced session is therefore already available through the front door,
legitimately, to anyone who asks for one. Claiming `trunk-caller` at `/link`
gets a visitor a differently-named profile with the same baud 0.

So this change does **not**, on its own, close the token-spend half of #74; it
closes the *spoof*. "The relay paces a session by the surface that session
actually is" is now true, and the remaining exposure — that two visitor
surfaces are unpaced by design — is a separate question about what bounds
`claude` spend, and belongs to `real-wopr#36` rather than here. It is named at
the bottom of this document so the next reader does not mistake this fix for
that one.

## The options

**Option 1 — the relay verifies the session's surface with the bridge before
applying a profile.** One round trip per dial. No wire format change, no new
endpoint (`GET /api/session/{id}` already exists and already returns
`surface`), no new secret anywhere.

**Option 2 — the bridge returns the surface in the mint response and signs it
into the session token**, so the relay can verify with no round trip.

**Option 3 — the relay ignores the query-string surface entirely and always
uses the stored one.** Deletes a parameter instead of verifying it.

## Decisions

1. **Option 1: the relay asks the bridge, on every `/link` dial.** The bug is
   two components disagreeing about what a session *is*; the fix that keeps
   working is the one that gives them a single authority, and the bridge's
   store is already that authority for everything else about a session
   (backdoor, room, system, engine). Pacing was the one property the relay
   decided from a string the caller typed.

2. **The round trip is affordable here, and the numbers are not close.** The
   lookup is an HTTP GET to the same host the leg is about to open a WebSocket
   to, on the internal Compose network — a millisecond or so. The dial it
   precedes is the **most deliberately slow moment in the product**:
   `runHandshake`'s authentic dial-up ritual is `2000ms` + `1000–4000ms` +
   `1000ms` + `2000ms` = **6 to 9 seconds** of DIALING / RINGING / CARRIER
   DETECT / HANDSHAKE before a single application frame crosses. A dial is not
   a hot loop — it happens once per call, where a terminal turn happens once
   per line typed — and the added latency is under a thousandth of the ritual
   the same dial performs on purpose. In `fast` mode there is no ritual, and
   the lookup is then the same order as the upstream WebSocket connect that
   follows it. There is no configuration in which this is the expensive part.

3. **Option 2 is rejected, and would have been even if latency mattered.**
   Three costs, any one of which outweighs a millisecond:

   - **It puts `SESSION_SECRET` in the relay.** Today the relay forwards the
     session token opaquely and cannot mint one; that is a real property, and
     it is why a compromised relay cannot manufacture bridge sessions. Signing
     the surface into the token means the relay verifies HMACs, which means it
     holds the key, which means it can also sign. Widening a secret's blast
     radius to save a round trip is a bad trade. (Signing with
     `BRIDGE_INTERNAL_TOKEN` instead avoids that but invents a second
     signing key over the same value, for the same saving.)
   - **It is a token format change, so it breaks live sessions.** Every token
     already minted covers `session_id` alone. On deploy, a relay that expects
     a surface-bearing token refuses every session minted before the bridge
     rolled — which is every session currently on the line. That needs a
     dual-accept grace period, a flag day, or both.
   - **It is a wire/API change** across two separately deployed containers,
     with an ordering constraint in each direction, to replace an endpoint that
     already exists and already returns exactly the field wanted.

4. **Option 3 is rejected because it silently corrects a caller that is doing
   something wrong.** A visitor who dials `?surface=trunk-caller` against a
   `home-terminal` session would simply be paced at 600 baud and told nothing —
   the attack "works" from the client's point of view and shows up nowhere.
   The same silence hides the honest version of the bug: a surface app whose
   mint and dial disagree (a copy-paste, a refactor) would run at the wrong
   surface's pacing forever with no signal. #79's virtue was that a refusal is
   as legible as a `401`; the sequel should not be quieter than its
   predecessor. And option 3 saves nothing: the relay must still learn the
   stored surface, so it is option 1 with the comparison deleted.

   Its stronger form — deleting `?surface=` from the URL — was considered and
   rejected too. Every surface app sets it (`crt-kit/src/link.ts`), as does
   `openLocalLeg`; removing it is a breaking URL change for the pack's own
   clients and for anyone hosting their own pack, in exchange for nothing the
   comparison does not already give.

5. **A mismatch is refused, with its own close code: `4403 surface does not
   match session`.** Not corrected, not downgraded to the stored surface's
   profile. `/link` already refuses with `4400 unknown surface or missing
   session`, and `/seat` uses `4408`/`4429` — the house style is
   `4000 + the HTTP status that fits`, so a forbidden claim is `4403`. Two
   further codes, because an operator reading a closed line has to be able to
   tell three different stories apart:

   | Close | Means |
   | --- | --- |
   | `4403 surface does not match session` | the caller asked for a surface that is not this session's |
   | `4404 unknown session` | the bridge has no such session (stale id, wrong exchange) |
   | `4503 session lookup failed` | the bridge could not be asked (down, slow, garbage answer) |

6. **The lookup fails closed.** A bridge that cannot be asked gets no dial —
   `4503`, before any shaper exists. Failing open would mean an outage of the
   bridge's HTTP face silently disables the control while its WebSocket face
   keeps working, which is the same shape of bug as #74's fail-open mint. The
   practical cost is nil: a bridge that cannot answer a GET is a bridge the
   leg's own upstream WebSocket was about to fail against anyway. The refusal
   simply arrives at the start of the ritual instead of at the end of it.

7. **The claim is validated before the network call, so a typo never reaches
   the bridge.** `resolveLink` on the query-string surface runs first and still
   answers `4400` for a surface this relay does not know — unchanged behaviour,
   no request made. The lookup happens only for a claim that would otherwise
   have been honoured.

8. **The profile is resolved from the stored surface**, not from the claim,
   even though they are equal by the time it happens. The authority should be
   visible in the code that uses it; a later edit that relaxes the comparison
   (say, to allow an alias) then still paces by the session rather than by the
   string.

9. **One mechanism, applied uniformly — no fast path for the machine legs.**
   `openLocalLeg` could present `x-wopr-internal-token` on its `/link` upgrade
   and skip the lookup, since it already holds the token. Rejected: a second
   trust path means two ways for `/link` to decide what a leg is, and the
   saving lands on the two legs of a machine call — precisely where a
   millisecond matters least, since that call has already done a session mint
   over the same HTTP.

10. **The lookup carries `x-wopr-internal-token` when the relay has one.**
    `GET /api/session/{id}` is unauthenticated today and the relay does not
    depend on the header being checked; it is sent because the relay already
    sends it to this host on the WebSocket connect, it costs nothing, and it
    leaves the bridge free to restrict that endpoint later without a second
    relay change. Omitted entirely when unset, exactly as `openLocalLeg` and
    the upstream connect do — "no header", never a blank one.

11. **No caching.** A per-session memo would save a request only on a redial,
    and a cached authorisation decision that outlives the fact it was based on
    is how this class of bug comes back. A dial is rare enough to pay full
    price every time.

12. **The socket is paused across the await.** The handler now begins with an
    asynchronous step, and a client that sends before the listeners are wired
    would otherwise lose those frames. `client.pause()` before the lookup and
    `client.resume()` once the leg is fully built keeps the existing guarantee
    that a frame sent ahead of `CONNECTED` is buffered, never dropped.

13. **The bridge is not changed at all.** No new endpoint, no new field, no
    token change. That is what makes this a single-service deploy (see below),
    and it is the strongest practical argument for option 1 over option 2.

## What is in scope, and what is deliberately not

- **`/link`** — covered. This is the only relay path that resolves a pacing
  profile from a caller-supplied surface *for a session this relay's bridge
  stored*.
- **`/seat?surface=…`** — not covered, and not a hole. A seat leg has no bridge
  session at all; the surface only names the profile an answered ring will be
  paced at, and every surface a caller could name there is one they could mint.
  There is nothing to cross-check against.
- **`/x/<CODE>/link`** — not covered at the hub, and cannot be: the hub is not
  the bridge that stored that session and has nothing to ask. It does not need
  to be. The hub relays the visitor's query string verbatim down the tie line,
  and the far exchange's tieline dials its own `/link` with it
  (`${opts.localComms}/link?${f.query}`, `tieline.ts`) — against the bridge
  that *did* mint that session. So a relayed visitor's surface claim is
  cross-checked at the exchange whose pacing it would have stolen, which is the
  right place for it. `trunk-e2e`'s byte-identity test covers exactly this
  path.

## Behaviour table

| Session's stored surface | `?surface=` | Result |
| --- | --- | --- |
| `home-terminal` | `home-terminal` | connects, paced `dialup-600` — unchanged |
| `home-terminal` | `trunk-caller` | **`4403`**, before any shaper exists (#80) |
| `home-terminal` | `norad-bigboard` | **`4403`** — a spoof, even though not an escalation |
| `trunk-call` / `trunk-caller` | same | connects, paced as before — machine calls unchanged |
| any | a surface this relay does not know | `4400`, no request to the bridge — unchanged |
| — (no session in the query) | any | `4400` — unchanged |
| no such session at the bridge | any | **`4404`** (was: connect, then `NO CARRIER` from the upstream refusal) |
| bridge unreachable / 5xx / unparseable | any | **`4503`** (was: connect, ritual, then `NO CARRIER`) |

The last two rows are the only behaviour change for a well-behaved caller: a
dial that was already doomed now fails at the start of the ritual instead of
after it, with a reason instead of a bare carrier drop.

## Deploy

**Nothing breaks, and there is no ordering constraint.** The change is
relay-only:

- **Live sessions are unaffected.** No token format change, no new field: a
  session minted five minutes before the deploy dials exactly as it did.
- **In-flight dials are unaffected.** The check runs at connect; an established
  `/link` socket is never re-verified.
- **A rolling deploy is safe in both directions.** During the roll, some dials
  hit an old relay (no lookup) and some a new one (lookup); both work against
  the same unchanged bridge.
- **The only new coupling** is that the relay now needs the bridge's HTTP face,
  not just its WebSocket face, to open a `/link`. Both already ride the one
  `BRIDGE_WS_URL` host (`openLocalLeg` has minted over it since #72), so this
  introduces no new configuration — but an exchange that firewalled the HTTP
  port between relay and bridge while leaving the WS port open would now refuse
  every dial with `4503`. No such deployment exists; named because it is the
  one way to misconfigure this.

**Amplification**, considered: a `/link` connect now causes an immediate GET on
the bridge, where before it caused an upstream WebSocket connect several
seconds later. A connect flood therefore reaches the bridge sooner. It reaches
it as a read-only GET, which is strictly cheaper than the unauthenticated
`POST /api/session` — a database write — that the same stranger can already
call directly. Nothing new is worth adding here.

`real-wopr`'s E08 eval asserts the machine-callback path end to end and probes
that a mint without the header is refused. Both still hold: `openLocalLeg`
mints `trunk-caller` with the token and then dials `?surface=trunk-caller` for
a session that really is `trunk-caller`, so it matches and connects. No eval
change is expected — but E08 lives in the sibling repo and could not be run
from here.

## Test matrix

Relay (`emulator/relay/tests/link-surface.test.ts`, new — its fake bridge is a
faithful one: it mints whatever surface is asked for, remembers it, and reports
it back on `GET /api/session/{id}`, so the attack below is performed rather
than simulated):

- **the attack**: mint `home-terminal` with no header, dial
  `?surface=trunk-caller` → closed `4403`, and no upstream socket is opened.
  This test fails on `main`, where the same dial connects paced at `off`.
- the same attack in the other direction (`?surface=norad-bigboard`) → `4403`
- an honest visitor dial (`home-terminal` / `home-terminal`) still connects,
  and the lookup was made
- a machine leg (`trunk-caller` / `trunk-caller`) still connects — the path
  #72 added must not regress
- unknown session → `4404`; bridge down → `4503`; bridge 500 → `4503`
- a surface this relay does not know → `4400` **and no request to the bridge**
- the lookup carries the internal token when configured, and no header when not

Node (`emulator/node/tests/test_trunk_surfaces.py`): `GET /api/session/{id}`
reports the surface the session was minted with, for every surface in
`DEFAULT_LINKS`. The relay's cross-check is now built on that field; a change
to it is a cross-service break, so it gets an assertion on the bridge side too.

Existing relay suites keep passing with their fake bridges taught to answer the
lookup (`tests/fake-bridge.ts`, shared rather than copied into the five files
that need it) — which is itself the point: every `/link` dial in the suite is a
dial whose session now has to exist. `tools/dev-bridge-stub.ts`, the dev-only
bridge stand-in, gets the same treatment: a socket-only stand-in is one every
dial would refuse `4503`.

Determinism is unaffected: no program, fixture or wire format changes.

## Adjacent, and deliberately not fixed here

**Two visitor surfaces are unpaced.** `norad-bigboard` and `wopr-panel` resolve
to `internal-bus` (`baud: 0`) and mint with no token, so an unpaced session
remains a thing any stranger can have — legitimately, through the front door,
with no spoof involved. Everything #74 said about pacing being the only
server-side bound on generated text, and the only bound on `claude` token
spend per connection, applies to them as written. Closing the token-spend
argument behind `real-wopr#36` therefore needs a bound that is not pacing (a
per-session cap, a budget, a surface-scoped engine policy) — not this fix and
not #79. It wants its own issue.
