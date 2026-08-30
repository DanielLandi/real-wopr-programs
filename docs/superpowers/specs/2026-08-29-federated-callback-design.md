# A federated peer can ring its visitor back — design

Date: 2026-08-29
Status: approved (design, spec and implementation pre-approved by Daniel)
Issue: [real-wopr-programs#75](https://github.com/DanielLandi/real-wopr-programs/issues/75)
Builds on: [`2026-08-29-trunk-surface-auth-design.md`](./2026-08-29-trunk-surface-auth-design.md)
and, in the engine repo, `2026-08-29-joshua-intention-design.md` (piece D) and
`2026-07-13-trunk-federation-design.md`.

Piece D gave Joshua the ability to ring a visitor back. It works on the flagship
and only on the flagship. This piece makes it work on a hosted exchange, and —
the half that is not optional — writes down where the boundary between the two
actually runs, because nothing did.

## 1. The topology, stated once

Three roles, and almost every confusion about this feature comes from collapsing
two of them.

| Role | What it runs | Who mints seat handles | How it places a call |
| --- | --- | --- | --- |
| **Hub** | a relay whose `Switchboard` holds every registered exchange | its own `SeatRegistry` | into its own switchboard |
| **Flagship** | the hub, *plus* a seeded world 1 (`TRUNK_LOCAL_WORLD`) and a bridge of its own | the hub's — the same process | into its own switchboard, as the seeded `homeSlot` |
| **Peer** | bridge + relay + a tie line out to the hub | **nobody local** — the hub mints, against the peer's exchange code | over the trunk it is already connected to |

The flagship is a hub that also hosts programs. That coincidence is why piece D
looked complete: on the flagship, "ask the hub to ring this seat" and "ask my own
relay to ring this seat" are the same sentence. On a peer they are not, and
`POST /trunk/place` only ever said the second one.

## 2. Why the HTTP path is structurally wrong for a peer

A seat handle is a **capability scoped to a pair**: `(seat, exchange code)`. It is
minted by the hub's `SeatRegistry` at the moment a visitor dials, and
`SeatRegistry.resolve(handle, presentingCode)` refuses a handle that the
presenting exchange did not earn exactly as it refuses one that never existed.
That is the whole design — a machine learns nothing about seats it has not spoken
to.

So for a peer:

- The handle lives in the **hub's** registry. The peer's relay has a
  `SeatRegistry` of its own, and that registry has never heard of the handle.
- `BRIDGE_TRUNK_URL` on a peer points at the peer's own relay. Posting the handle
  there asks the wrong registry.
- Pointing it at the hub instead fails differently and worse: the peer does not
  hold the hub's `BRIDGE_INTERNAL_TOKEN`, so #74's guard answers `401`; and even
  with the token, the hub places as `seededCode(homeSlot)` — the *flagship's*
  WOPR — so `resolve()` would refuse the handle for presenting the wrong
  exchange. Handing peers the hub's internal token to fix the first problem would
  hand every host operator the credential that mints `trunk-caller` sessions on
  the flagship. There is no configuration of the HTTP route that is correct here.

**A correction to the issue.** #75 predicts `seat-gone` on every attempt. What a
peer actually gets today is `409 {"refused":"offline"}`, one step earlier:
`TRUNK_LOCAL_WORLD` is a hub setting, a peer does not set it, so
`switchboard.seededCode("WOPR")` is `undefined` and the route refuses before it
ever reaches the seat branch. Same silence, different word.

**And a defect the issue did not reach.** The handle never got as far as the
peer's bridge in the first place. The hub sends it down the trunk on the OPEN
(`origin: { seat }`), but `tieline.ts`'s visitor branch only ever pasted the
relayed query into its own `/link` — and the hub deliberately strips `seat=` from
that query, because the seat *token* is the one credential a foreign host must
never see. So a peer's `ws_session` recorded no `seat_handle`, `if seeks and
seat_handle:` was false, and `place_seat_call` was never called at all. The
callback on a peer was not failing at the last hop; it was failing at the first,
and both halves have to be fixed for either to matter.

## 3. Decisions

**1. The bridge never learns which kind of installation it is on.** `BRIDGE_TRUNK_URL`
keeps meaning "my own relay's HTTP base", `place_seat_call` keeps posting
`{"seat": handle}`, and `main.py` is untouched. The relay is the component that
already knows the topology — it is the thing holding either a switchboard or a
tie line — so the routing decision belongs there and nowhere else. A bridge that
had to branch on flagship-versus-peer would be a second place for the two to
disagree, and this issue exists because there was already one.

**2. The relay hosts the tie line in its own process.** `startTieline` moves from
"a third process `tools/host.sh` starts" to "something `startServer` starts when
it is configured for it". This is what makes decision 1 buildable: the routing
decision and the trunk socket have to be reachable from one another, and an
in-process function call is a smaller thing to get right than a new
relay↔tieline control protocol with its own auth, framing and reconnect
semantics. `npm run tieline` stays exactly as it was for anyone wiring their own
stack; `startTieline` is still an exported function with the same signature plus
one optional callback.

**3. A relay is a peer when it has a tie line, and it has a tie line when
`TRUNK_HUB_URL` is set.** That is the entire test — there is no new "am I a peer"
flag, and no attempt to infer it from the shape of a failure. `tools/host.sh`
exports `TRUNK_HUB_URL` (with its documented default) before starting the relay,
so an operator who runs `make host` gets a peer without typing anything new, and
an operator who runs the relay any other way gets the hub behaviour it has always
had.

**4. A hub is never a peer.** If a relay has a seeded local world
(`TRUNK_LOCAL_WORLD` non-empty) it is a hub, and it refuses to start a tie line
even if `TRUNK_HUB_URL` is also set — printing one line saying so. Without this
guard, a stray `TRUNK_HUB_URL` in the flagship's compose environment would have
the hub dial *itself*, register as an ordinary exchange, and route its own
callbacks out through that loop: the film's beat, broken in production, by a
variable that today means nothing to the relay at all. The guard turns a silent
misconfiguration into a visible one, which is this issue's whole theme.

**5. Every placement from a peer goes over the trunk — not just seat targets.** A
peer has no switchboard of its own worth consulting: nothing registers with it,
and `seededCode()` answers `undefined` for everything. Routing only *seat*
targets over the tie line and leaving `{slot, world}` on the local path would
leave a second wrong answer in place for the next feature to trip over. One rule:
**if this relay has a tie line, `POST /trunk/place` is a `PLACE` frame on that
tie line.** The one-hop depth cap (`on`) is forwarded unchanged, so the hub
applies exactly the same loop prevention it applies to any other host's PLACE.

**6. A handle minted elsewhere reaches the peer's program through the peer's own
`/link` disclosure, keyed by session id.** The tie line already knows the session
the relayed visitor minted — it is in the query the hub forwarded. So on an
inbound OPEN carrying `origin: { seat }`, the tie line hands `(session, handle)`
to the relay that is about to receive that `/link` connection, and `linkWss`
discloses `ORIGIN seat <handle>` on it exactly as it does for a locally minted
handle. The program sees the same envelope on a peer as on the flagship, which is
what lets decision 1 hold.

The entry is **one-shot and expires in 60 seconds**. It is consumed by the very
next `/link` for that session, which the tie line opens microseconds later; it is
never re-read, never persisted, and the map is capped so a flapping trunk cannot
grow it. It also never crosses a wire and never appears in a URL: it is passed by
reference inside one process, which is the reason decision 2 is worth its cost.
A handle is not minted, held or released locally — the hold and the ring timeout
live at the hub, where the seat actually is.

**7. No queue and no retry, unchanged.** Piece D's rule survives verbatim: one
intention per session, placed at hangup, discarded if it is refused. A peer's tie
line being down at that instant is a refusal like any other. Nothing is stored to
be tried again later, because a handle whose seat leg lives in the hub's memory
is worth nothing after either process restarts.

**8. Failure is loud in the operator's own log.** See §5.

## 4. The path, end to end

A visitor at David's desk dials a **peer**:

1. The browser holds a seat on the **hub** (`/seat`, the causal `SEAT?`
   handshake) and dials `wss://hub/x/<peer code>/link?…&seat=<token>`.
2. The hub mints `handle = seats.mint(token, <peer code>)`, strips `seat=` from
   the query, and sends the peer `OPEN { chan, query, origin: { seat: handle } }`.
   It takes `hold()` on the seat leg, so the seat cannot be rung while the
   visitor is on the call.
3. The peer's tie line sees `origin.seat`, reads `session` out of the query, and
   registers `(session → handle)` with its own relay before dialling
   `ws://127.0.0.1:<comms>/link?<query>`.
4. The peer's relay finds the session in that map and pushes
   `ORIGIN seat <handle>` as the first thing on the upstream leg. The peer's
   `ws_session` records `seat_handle`, exactly as the flagship's does.
5. Joshua reads out the Falken dossier. `JoshuaReply.seeks` is set; `ws_session`
   latches the intention.
6. The visitor hangs up. The hub releases the hold. The peer's `finally` block
   posts `{"seat": handle}` to `BRIDGE_TRUNK_URL` — its own relay — with the
   internal token the two local services already share.
7. The peer's relay has a tie line, so it sends `PLACE { call, to: { seat:
   handle } }` up the trunk instead of into its own switchboard.
8. The hub's `Switchboard.placeCall` resolves the handle **against the peer's own
   exchange code** — which is the code it was minted for — and rings the seat.
9. The seat answers. The peer's tie line attaches a `trunk-caller` local leg:
   an ordinary session on the peer's own bridge, which greets on connect. The
   visitor hears their own exchange's Joshua, paced at the seat's baud by the
   hub, because the answering end paces.

Steps 7–9 are the trunk `PLACE` seat target that #75 identified and piece D did
not use. Steps 3–4 are the half that had to be built for step 6 to have a handle
to send.

## 5. When it cannot happen, and who is told

The worst property of the current behaviour is not that it fails; it is that it
fails silently, forever, in a component nobody is watching. Every failure below
now prints one line where a `make host` operator is already looking — the same
uppercase operator vocabulary as `TIE LINE UP` and `LINE REFUSED`.

| Situation | Answer to the bridge | What the operator sees |
| --- | --- | --- |
| Peer, trunk up, seat answers | `201 {chan}` | `CALLBACK PLACED — CHAN n` |
| Peer, **no tie line at all** and no seeded world | `409 offline` | `CALLBACK NOT PLACED — NO TRUNK — …` (stderr) |
| Peer, **tie line down** at the instant the intention fires | `409 offline` | `CALLBACK NOT PLACED — TIE LINE DOWN` (stderr) |
| Hub refuses: seat hung up between intention and placement | `409 seat-gone` | `CALLBACK NOT PLACED — SEAT-GONE` |
| Hub refuses: seat already on another call | `409 busy` | `CALLBACK NOT PLACED — BUSY` |
| `BRIDGE_TRUNK_URL` unset on the bridge | never posted | `callback: BRIDGE_TRUNK_URL is unset — …` (bridge warning) |
| A relay configured as both hub and peer | hub behaviour | `TIE LINE IGNORED — THIS RELAY IS A HUB …` (stderr, at startup) |

The split between the two columns is deliberate. `seat-gone` and `busy` are
**truthful outcomes of a real call**: the person hung up, or is talking to
someone else. They are logged, not shouted. `NO TRUNK`, `TIE LINE DOWN` and
`TIE LINE IGNORED` are **configuration or connectivity faults** — the operator
can fix them — so they go to stderr.

The last row of the bridge column is the one that matters most for a dev box: a
bridge with no `BRIDGE_TRUNK_URL` used to return the string `"no hub"` with no
log line anywhere, which is precisely the silent-forever failure #75 is about. It
now says so once per attempt.

**A peer with no tie line is not an error state to fail startup on.** A clone run
as a monolith is a supported way to use this repo, and a monolith that never
federates should not refuse to boot because Joshua might one day want to phone
someone. The line prints when a callback is actually attempted, which is the
first moment the missing trunk is a real problem rather than a hypothetical one.

## 6. Is `BRIDGE_TRUNK_URL` still needed?

Yes, and for one reader: **the flagship**, where the bridge and the relay are
separate containers and the bridge has to be told the other container's name
(`http://comms:8081`). It cannot be derived — there is no convention that says a
bridge's relay is on loopback when in production it is on a compose network.

For a **peer** it is no longer something an operator sets: `tools/host.sh` exports
`BRIDGE_TRUNK_URL=http://127.0.0.1:$COMMS_PORT` alongside the ports it already
picks, because on a hosted exchange the relay is by construction on loopback. An
operator who sets it anyway keeps their value — the same command-line-wins rule
`host.sh` applies to everything else.

So the variable's meaning narrows and does not change: *where this bridge reaches
its own relay*. What changed is that the answer is now derivable for a peer, and
that the relay behind it may or may not be a hub.

## 7. What this deliberately does not do

- **No retry, no queue, no persistence.** §3.7.
- **A peer's relay is still a `Switchboard`.** Nothing stops a third party
  REGISTERing with a peer's relay if they can reach its port; that has always
  been true, is not what this issue is about, and the tie line is unaffected by
  it. A peer binds loopback by default.
- **`/link`'s surface is still taken from the query string** and still not
  cross-checked (#80). The relayed-handle map is keyed on `session`, not on
  surface, so this piece neither depends on that nor makes it worse.
- **The seat→machine direction is still unpaced** (real-wopr-programs#71).
- **Nothing in `emulator/node/app/main.py` changes.** That is decision 1
  working, not an oversight.

## 8. Test matrix

Everything below is in the `relay` job, because the trunk is the relay's. The CI
job named `federation` is the NODE/1 wardialling federation (`emulator/cli`,
`make up`) — a different federation from TRUNK/1, and not the one this piece
touches.

| Case | Shape |
| --- | --- |
| **A peer rings its visitor back, end to end** | real hub + real peer relay with an in-process tie line + real seat + real visitor; the handle reaches the peer's bridge as `ORIGIN seat …`, and a `POST /trunk/place` on the **peer** rings the seat at the **hub** |
| The peer's own Joshua answers | answering the ring mints a `trunk-caller` session on the **peer's** bridge, not the hub's |
| A relayed handle is one-shot | a second `/link` on the same session gets no `ORIGIN` |
| Tie line down | `409 offline`, and `TIE LINE DOWN` on stderr |
| No trunk at all | `409 offline`, and `NO TRUNK` on stderr |
| A hub is never a peer | a seeded relay given `TRUNK_HUB_URL` starts no tie line and says so |
| The flagship is unchanged | the existing `/trunk/place` and seeded-slot suites stay green untouched |
