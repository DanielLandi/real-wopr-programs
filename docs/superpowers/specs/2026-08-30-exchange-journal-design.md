# The exchange's own journal rows — design (#88)

**Issue:** real-wopr-programs#88. **Predecessors:** #78 item 3 (the `origin`
summary key), real-wopr#204 (E10, the `EVENTS` eval).

## The defect

`ORIGIN world N slot X` — the provenance of a machine-placed call — was logged
against the `trunk-call` session it arrived on. That is the machine end of a
call: no operator sits there, and `EVENTS` reads one session's rows from a
`norad-terminal`. So the row was recorded and rendered correctly and could be
read from nowhere but a unit test that fabricated it.

## What the code rules out

The issue offered a room-scoped `EVENTS` as the principled direction. The code
says it would not reach this row:

- The relay mints trunk legs without a room (`relay/src/tieline.ts`,
  `server.ts`: no `room_code` on the session POST), so a room-scoped read from
  a console — roomed or not — still never sees the machine leg.
- E10, merged, pins that two roomless consoles cannot read each other's rows.
  Treating "roomless" as one shared room (the `GLOBAL_ROOM_KEY` reading
  `TRACKS` uses for games) would reverse that eval.

So room scoping is neither sufficient nor free, and it is set aside. A
cross-session read "for machine legs specifically" (the issue's option 2) would
be a special case in the reader for a fact about the writer.

## The decision

**The provenance row belongs to the exchange, not to a session.** It is logged
with `session_id=None` — the shelf `exchange-registered` already sits on
(`POST /api/exchanges/register`) — and `get_recent_events(sid)` returns the
session's own rows *plus* the exchange's, interleaved in order, under the same
limit. Every console at the installation reads the same exchange rows; no
console reads another's (E10 holds, and the new `test_api` case asserts the
machine leg's own typed line stays its own).

`EVENTS` learns one more summary key, `event`, appended after `origin` under
#78's append-only rule, so the exchange-registered row does not now render with
the blank summary #78 item 3 was about.

Rows with no session were already a shape the schema allowed (`event_logs.
session_id` is nullable and `on delete set null`); no migration.

## Against #106 (merged)

#106 moved the operator console into `norad/`, which asks its host for
`journal RECENT n`. The host side is this same `store.get_recent_events(self.sid,
limit)` and this same summary tuple (`router._journal`), so the Fortran console
renders the exchange's rows with no change of its own: the row reaches it as an
`EVENT route system origin world 1 slot PANAM` card like any other.

## Redaction

The origin string comes from the relay's control frame (world and slot from its
own config), never from typed input, and the access-code redaction is applied at
the writer. The row is upper-cased and cut at 44 columns like every other.
