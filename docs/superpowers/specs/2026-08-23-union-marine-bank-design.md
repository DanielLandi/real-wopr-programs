# Union Marine Bank — design

Date: 2026-08-23
Status: approved (brainstormed with Daniel; all five sections approved)
Issue: [real-wopr-programs#42](https://github.com/DanielLandi/real-wopr-programs/issues/42)

Promote the film's bank to a real period system on the SYSTEM/1 tier: a COBOL
back-office inquiry desk at `systems/umb/`, dialable, in the phone book and the
war-dial sweep.

## Why this is now in scope

The 2026-08-03 fidelity batch deliberately did *not* add the bank to the
war-dial hit list, because a dialable hit needs a real system behind it and the
browser-sim tier is retired. That reasoning is unchanged; what changed is that
the system now gets built.

The engine repo's `docs/period-systems.md` currently lists the bank in its
language map as **out of scope**, `In film: —`, with the rationale "Andy Glenn's
zompiexx interpretations; acknowledged, not copied". That row is wrong on its
facts: the film shows an on-screen banner,

```
UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER
```

attested by two sources (`mw.rat.bz/wgterm` and the zompiexx recreation).
Confirmed by Daniel on 2026-08-23.

The Non-goals entry — "Copying Andy Glenn's specific system designs (bank / BBS
/ starwars / telstar)" — is untouched by this work and stays as written. It
forbids copying someone else's design, not building a bank. Everything here is
written from scratch.

The bar this clears is not a high one, and the precedent is explicit: the
language map records Protovision as `named` (never shown on screen) and Pacific
Telephone as `implied`, and both were built. A banner line is stronger evidence
than either had.

## Decisions made during brainstorming

- **Logon wall plus a read-only inquiry desk**, not a locked front door and not
  a full back office. A door nobody opens is the "placeholder as a full system"
  the program lists as a non-goal, approached from the other side; transactions
  would double the size for content the film never implies.
- **The way in is a service bulletin**, self-contained on the system itself —
  not a credential discoverable through PACTEL or the school. Cross-system
  discovery reads better but couples the bank to slots that may be unregistered
  in a given world, and a visitor who dials the bank first would hit a wall with
  no in-world hint.
- **COBOL**, matching the airline's reasoning (1983 banking back-office ran
  COBOL under CICS on IBM mainframes) and adding no toolchain: GnuCOBOL is
  already required for `airline` and `reference`. PL/I and 370 assembler are
  both defensible on purity and both cost a new toolchain row, a new CI
  dependency, and a new build pattern for a system with one line of film
  footprint.
- **No film characters in the data.** A David Lightman account is tempting and
  asserts something the film does not. This system's entire justification is
  discipline about what is shown.
- **Read-only means no persisted state.** The manifest declares no `node.state`,
  unlike `pactel`.

## The fidelity boundary

One line wide, and it must be stated in the system's `README.md` and in the
amended `period-systems.md` row:

| Element | Provenance |
| --- | --- |
| `UNION MARINE BANK` / `SOUTHWEST REGIONAL DATA CENTER` | **shown** — the film's banner |
| Logon prompt, rejection wording, attempt limit | interpretation |
| Service bulletin and the field-service account | interpretation |
| Inquiry command surface, subsystem name and release | interpretation |
| Every account, branch, balance and transaction | interpretation |

## 1. The session

Three states, carried in the opaque `STATE` block as an authentication flag and
a failed-attempt count. Nothing else persists; the bridge echoes `STATE` back
each turn per SYSTEM/1 §2.

`CONNECT` paints the banner and prompts for logon, `LINE UP`:

```
UNION MARINE BANK
SOUTHWEST REGIONAL DATA CENTER
AUTHORIZED ACCESS ONLY - TYPE NEWS FOR SERVICE BULLETIN
```

While unauthenticated, an input line is a logon attempt, except `NEWS`, which
prints the bulletin:

```
UMB DATA CENTER - SERVICE BULLETIN 83-114
  BATCH WINDOW MOVED TO 0200 EFFECTIVE 04-27.
  FIELD SERVICE LOGON UMBFS1 REMAINS ENABLED PENDING
  REMOVAL BY DATA CENTER OPERATIONS.
```

That bulletin is the way in: a period-plausible operations notice that leaks a
dormant account someone forgot to remove. It rewards a visitor who types
something other than a guess, and it needs no other system to be reachable.

A wrong logon reports `LOGON REJECTED - ATTEMPT n OF 3`. The third prints a
security notice and drops the line (`LINE DROP`) — a second display that has to
survive the carrier drop, so it covers #62's path from the other end.

`NEWS` is the only unauthenticated input that is not a logon attempt, and it
does not count against the three. Everything else does, **including an inquiry
command typed too early**: `ACCT 4471-08822` before logon is consumed as a
failed logon named `ACCT 4471-08822`, not answered and not specially diagnosed.
The system never reveals that a command surface exists behind the wall.

`UMBFS1` authenticates:

```
UMB INQUIRY SUBSYSTEM  REL 3.2
FIELD SERVICE - READ ONLY
READY
```

Authenticated commands, deliberately four:

| Command | Response |
| --- | --- |
| `HELP` | the command list |
| `ACCT <n>` | number, name, branch, balance, hold — or `ACCOUNT NOT ON FILE` |
| `HIST <n>` | recent transactions, most recent first — or `ACCOUNT NOT ON FILE` |
| `BYE` | sign-off display, then `LINE DROP` |

Any other input, once authenticated, answers `INVALID COMMAND - TYPE HELP`.

`BYE` returning `LINE DROP` also exercises the sign-off path fixed in #62: the
display must survive the carrier drop at line rate.

## 2. Data

Two `LINE SEQUENTIAL` flat files under `systems/umb/data/`, following the
convention `airline` and `reference` already use — fixed-width fields, read with
a `READ ... AT END` loop, no indexed files.

- `accounts.dat` — account number, name, branch number, branch city, balance,
  hold. ~40 records.
- `history.dat` — account number, date, description, amount. ~150 records,
  grouped by account.

Invented Seattle-area customers. Enough records that `ACCT` and `HIST` feel like
a real file; far short of the airline's 342 passengers, because nothing in the
film asks for that scale.

Determinism (`CONTRIBUTING.md` §Determinism and period discipline): every date
and balance is a fixed string in the data. No wall clock, no randomness, and
being read-only there is no state to mutate. Same request bytes ⇒ same response
bytes, trivially.

## 3. Files

```
systems/umb/
├── umb.cob                     the program
├── README.md                   what is shown vs interpreted
├── data/
│   ├── accounts.dat
│   └── history.dat
└── harness/
    ├── manifest.json
    ├── build.sh                reads ../umb.cob, writes bin/umb
    └── tests/                  golden .in/.out pairs
```

`manifest.json`: `id: umb`, `title: UNION MARINE BANK`, `language: cobol`,
`binary: umb`, `number: (408) 555-0164`, `timeout_s: 2`, and
`node.networks.pstn.address` matching the number, protocol `SYSTEM/1`. No
`node.state` — the system is read-only.

The number sits in Protovision's `(408)` Sunnyvale exchange rather than PACTEL's
`(311)`, because the bank was a hit in the same war-dial sweep.

## 4. Integration

The pack enforces both directions of this now, so neither step is optional:

1. `tools/gen-dial-directory.py` regenerates `pack.json`'s `programs[]` and the
   dial directory from the manifest. CI runs `--check`, so a stale `pack.json`
   fails the build.
2. `emulator/web/home-terminal/app/sims.ts` must account for every dialable
   system or the import throws by name. `umb` is **listed**: a `LISTED` entry
   puts it in the phone book, and its `label` becomes the `WARDIAL_LABELS` entry
   that makes it a war-dial hit — which is what #42 asked for.

## 5. Documentation

In this repo:

- `systems/umb/README.md` — the fidelity boundary table above.
- `CREDITS.md` — acknowledge the two banner sources as evidence for the shown
  line. They are cited as attestation, not reused as design.

In `../real-wopr` (paired-repo flow: pack lands first, then re-pin):

- `docs/period-systems.md` — replace the "Bank, BBS, other 1983 systems … out of
  scope" row with a built row: COBOL, "banking back-office ran COBOL", `In film:
  shown (banner)`, `✅ built (2026-08-23)`. Any remaining BBS/starwars/telstar
  systems keep their out-of-scope row. The Non-goals entry stays verbatim.
- `docs/systems.md` — a §4.6 for `umb`, following §4.5's shape for PACTEL.

## Testing

Golden fixtures, 14–18 pairs, byte-exact per `CONTRIBUTING.md` §The contract:

- connect banner
- `NEWS` bulletin, unauthenticated
- three rejected logons, the third returning `LINE DROP`
- successful logon on `UMBFS1`
- `HELP`
- `ACCT` on a known account; `ACCT` on an unknown one
- `HIST` on a known account; `HIST` on an unknown one
- an inquiry command typed before logon, consumed as a failed attempt
- a malformed command
- an oversize input line
- `BYE` returning `LINE DROP`

Then `make build && make test`, and `tools/gen-dial-directory.py --check`.

The relay, node, web and CLI suites are untouched by this work; `sims.ts`'s
listing is covered by the existing import-time assertions on both sides.

## Sequencing

Pack changes land here first — its CI gates them, and `main` is branch-protected
(squash-only, all nine `pack` jobs required). Then `packs.lock` is re-pinned in
`../real-wopr`, where the `period-systems.md` and `systems.md` amendments land in
the same PR as the re-pin, and the evals re-run against the new pack.
