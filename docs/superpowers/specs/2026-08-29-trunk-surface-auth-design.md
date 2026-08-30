# Trunk surfaces are internal — design

Date: 2026-08-29
Status: approved (design, spec and implementation pre-approved by Daniel)
Issue: [real-wopr-programs#74](https://github.com/DanielLandi/real-wopr-programs/issues/74)

`POST /api/session` will mint a session for any surface a caller names, and two
of those surfaces are the machine ends of a machine-to-machine call. Require the
service-to-service token **on those two surfaces only**, so the machine ends
become unreachable from a browser without touching the front door every visitor
comes through.

## How the exposure arose

Neither half was wrong on its own; they met.

`POST /api/session` has never authenticated its caller, and it did not need to.
Every surface it could mint — `home-terminal`, `norad-terminal`,
`norad-bigboard`, `wopr-panel` — is a surface a stranger is *supposed* to be able
to open. A minted session is not access to anything: it lands at `LOGON:`, paced
at the surface's baud, and the film's front door is the whole point.

Worlds phase 2 piece D (#72) then had to add `trunk-call` and `trunk-caller` to
`DEFAULT_LINKS`, because the relay's `openLocalLeg` mints an ordinary bridge
session for each end of a machine call and the bridge was answering 400 for
both. The same piece made a `trunk-caller` session — the end that *placed* the
call — greet on connect through `Router.open_backdoor`, because the machine that
dials is the one with something to say.

Put together, the two additions hand a browser something no visitor surface
gives it:

```
curl -X POST https://wopr.realwopr.ai/api/session \
     -d '{"surface":"trunk-caller","system":null}'      -> 201
```

That session is behind the front door from the moment it connects, and its link
profile is `off` — baud 0, no handshake — because a call is paced once, by the
end that answered. Verified live against the exchange on 2026-08-29.

## What is actually at stake

Not a new door. Typing `JOSHUA` at the front door opens the same one, by design,
and that is the film. Two narrower things:

1. **Output pacing is the only server-side rate limit on generated text.** A
   `trunk-caller` session skips it. For the `claude` engine, pacing is also the
   only thing bounding token spend per connection.
2. **It is reachable without the ritual** — no dial, no handshake, no `LOGON:` —
   so it is by a wide margin the cheapest way to script against the exchange.

## Decisions

1. **Guard the surface, not the endpoint.** `POST /api/session` stays
   unauthenticated for every visitor surface. Authenticating the endpoint as a
   whole is the version of this change that takes the site down: every browser
   that dials realwopr.ai mints its session here, cross-origin, with no
   credential to offer. The two trunk surfaces are the only ones that exist for
   a caller who already holds `BRIDGE_INTERNAL_TOKEN`, so they are the only ones
   that require it.

2. **The set of internal surfaces is named, not inferred.** A module-level
   `INTERNAL_SURFACES` frozenset sits beside `DEFAULT_LINKS` in `app/main.py`.
   Inferring it from a `trunk-` prefix would be quieter and would silently
   mis-guard the first machine surface that is not named `trunk-anything`. A
   test asserts the other direction — that every `trunk-*` entry in
   `DEFAULT_LINKS` is in `INTERNAL_SURFACES` — so the likely mistake (adding a
   third trunk surface and forgetting the guard) fails in CI rather than in
   production.

3. **Missing or wrong header on an internal surface: `401`.** The relay's
   `openLocalLeg` treats any non-2xx as `"refused"` and closes the leg with
   `no session`, so the exact status is a diagnostic for an operator, not a
   control signal. `401` is the honest one: the trunk surfaces are documented in
   this public repo, so hiding their existence from a caller that reached a
   configured exchange buys nothing and costs the operator whose relay token
   drifted a clear answer.

4. **An unconfigured bridge refuses the trunk surfaces entirely, with the same
   `400 unknown surface` a bogus surface gets.** If `BRIDGE_INTERNAL_TOKEN` is
   unset there is no header any caller could send that would be correct, so
   fail closed: an exchange with no internal token behaves exactly as it did
   before piece D — the machine surfaces do not exist. Reusing the existing
   `400 unknown surface` rather than inventing a `503` also means an
   unconfigured deployment discloses nothing about its configuration.

   This deliberately **differs from the `/ws/session/{id}` guard**
   (`main.py`, D3), which fails *open* when the token is unset. That guard can
   afford to: it still verifies an HMAC session token, so an unconfigured bridge
   is not a bare hole. The session mint has no second factor — fail-open there
   is precisely the bug this document is about — and it matches the closest
   analogue, the relay's `/trunk/place` route, which 404s when unconfigured
   rather than let an unauthenticated POST reach the switchboard.

5. **The misconfiguration is loud once, at startup, not once per request.**
   `create_app` logs a warning when `internal_token` is empty, naming the
   consequence ("machine calls cannot mint a session"). Logging per refusal
   would be louder in the wrong way: `POST /api/session` is public, so a
   per-request warning is a log-flood vector that any stranger can pull. A
   deployment-level fact gets a deployment-level line.

6. **The header is ignored on visitor surfaces — present, absent, or garbage.**
   The rule is "these two surfaces require it", not "this header must be valid
   wherever it appears". Validating it on `home-terminal` would turn a stray
   proxy header into a 401 on the front door, which is the same outage as
   decision 1 arriving by a side road. It also must never be able to *change*
   what a visitor surface does; it does not.

7. **`openLocalLeg` takes the token as an option, with a
   `process.env.BRIDGE_INTERNAL_TOKEN` fallback**, mirroring
   `startServer`'s existing `opts.internalToken ?? process.env… ?? ""`. The
   three call sites differ in what they have to hand: `seededPort` runs inside
   the hub and is passed the value `startServer` already resolved; the tieline
   is a separate process next to a local stack and gets a new optional
   `TielineOpts.internalToken`; tests pass it explicitly. When it is empty the
   header is omitted rather than sent blank, so an unconfigured relay produces
   "no header" and not "wrong header".

8. **Comparison is `secrets.compare_digest` over UTF-8 bytes.** Timing analysis
   across the public internet against a random token is not a live threat, but
   the byte form also removes the `compare_digest` ASCII-only `TypeError` a
   caller could otherwise trigger with a non-ASCII header value — a 500 from a
   public endpoint. The existing `/ws/session` `!=` comparison is left alone;
   changing an auth path that is not this bug belongs in its own change.

## Behaviour table

| Surface | `x-wopr-internal-token` | Bridge `internal_token` | Result |
| --- | --- | --- | --- |
| `home-terminal`, `norad-terminal`, `norad-bigboard`, `wopr-panel` | absent | any | `201` — unchanged |
| any visitor surface | wrong / garbage | any | `201` — header ignored |
| `trunk-call`, `trunk-caller` | matching | set | `201`, profile as before |
| `trunk-call`, `trunk-caller` | absent | set | `401 unauthorized` |
| `trunk-call`, `trunk-caller` | wrong | set | `401 unauthorized` |
| `trunk-call`, `trunk-caller` | anything | unset | `400 unknown surface` |
| anything else | any | any | `400 unknown surface` — unchanged |

A refusal happens before the room, system and processor validation that follows
it, so an unauthenticated call creates no room and touches no `last_seen_at` —
the same "a refusal has no side effects" rule the system/room checks already
follow.

## What a misconfigured deployment looks like

The failure mode worth naming is a **relay that does not send the header talking
to a bridge that requires it**: every machine call refuses at the mint. Where
that shows up:

- **The bridge**, once at startup, only in the both-unset case (decision 5).
- **The relay**, per call: `openLocalLeg` returns `"refused"`, the leg's `close`
  runs with `no session`, and the tieline / seeded port sends an explicit
  `CLOSE … reason: "no session"` upstream so the hub frees the channel. That
  reason already travels to the far end.
- **A visitor**, not at all — no visitor path mints a trunk surface, so a
  misconfiguration of this kind is invisible to the front door. That is the
  intended blast radius.

It is therefore **order-sensitive at deploy time**: ship the relay first (it
starts sending a header the bridge does not yet require, which is inert), then
the bridge. The reverse order stops machine calls minting for the length of the
gap. Both services already read `BRIDGE_INTERNAL_TOKEN` from the same
deployment, so no new configuration is introduced.

## Test matrix

Node (`emulator/node/tests/test_trunk_surfaces.py`), the suite that already owns
the machine surfaces:

- every non-internal surface in `DEFAULT_LINKS` mints with **no** header — the
  required test, parametrised over the allowlist so a new visitor surface is
  covered the day it is added
- a visitor surface mints with a **wrong** header
- `trunk-call` / `trunk-caller` with no header on a configured bridge → `401`
- `trunk-call` / `trunk-caller` with a wrong header → `401`
- `trunk-call` / `trunk-caller` with the right header → `201` and the same link
  profile as before (`dialup-1200` / `off`)
- `trunk-call` / `trunk-caller` on a bridge with no internal token → `400`, and
  byte-identical to the answer for a surface that does not exist
- structural: every `trunk-*` key of `DEFAULT_LINKS` is in `INTERNAL_SURFACES`
- the existing behavioural tests (a placed call greets, an answered call still
  knocks) keep passing, now through the authenticated mint

Relay (`emulator/relay/tests/local-leg.test.ts`):

- `openLocalLeg` sends `x-wopr-internal-token` when given one
- it omits the header entirely when it has none
- it falls back to `process.env.BRIDGE_INTERNAL_TOKEN`
- a bridge that answers `401` yields `"refused"` and one `close`

Determinism is unaffected: no program, fixture or wire format changes, and the
guard reads only a request header and a settings value.

## Adjacent, and deliberately not fixed here

`/link` takes its surface from the query string and the relay never checks it
against the surface the bridge stored for that session
(`resolveLink(config, surface)`, `server.ts`). A visitor can therefore mint an
ordinary `home-terminal` session and then dial
`/link?surface=trunk-caller&session=…&token=…` to be paced at profile `off`.
That is a **pacing** bypass only — the bridge decides the backdoor from the
surface it stored, which this change now protects, so it is not a way back into
a pre-authenticated session — but it does mean concern 1 above is not fully
closed by this change alone. Fixing it means the relay cross-checking the
session's surface with the bridge, which is a round trip on every dial and a
design change of its own. It belongs in its own issue, not in a change whose
first requirement is not breaking the front door.
