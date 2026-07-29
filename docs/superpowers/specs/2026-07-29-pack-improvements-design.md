# Six pack improvements — design

Date: 2026-07-29
Status: approved (brainstormed with Daniel; all six sections approved)

Improvements to the WOPR Program Pack driven by a first live dial-through of the
federation: faster line rate, same-line prompts, clearer school menu, richer
Protovision and PacTel content, and caps-free typing.

## Decisions made during brainstorming

- **1200 baud**, not the requested 900: 900 was never a modem rate; the period
  ladder was 300 → 600 → 1200 and the relay already ships `dialup-1200`.
- **Same-line prompts via a SYSTEM/1 `PROMPT` block** (protocol extension), not
  harness output-framing heuristics. Explicit over implicit, at the cost of
  touching all five systems and their fixtures.
- **PacTel billing as a single program** with persistent node state — not a
  separate `pactel-db` bus store — with a documented growth path to the
  school/school-db pattern if billing outgrows the test board.
- **Protovision** gains `I <n>` info pages and an `A` company page; the catalog
  stays at five titles; no ordering flow.
- **Uppercase at the terminal client**, styled as a caps-only 1983 terminal;
  programs never see lowercase.

## 1. Phone network at 1200 baud

- `pack.json` → `networks.pstn.baud: 1200`. The relay resolves the existing
  `dialup-1200` profile (120 ms latency, 60 ms jitter, dialup handshake).
- `emulator/relay/src/config.ts` → `surface_links["home-terminal"]:
  "dialup-1200"` so the web terminal matches the CLI.
- Docs that say "300 baud" update: root `README.md`, `emulator/README.md`.
- `norad` stays 9600; `bus` stays unshaped. No shaper code changes.

## 2. SYSTEM/1 `PROMPT` block

A response may carry one optional line between the `DISPLAY` block and `LINE`:

```
DISPLAY <k>
<k lines>
PROMPT <text>        <- optional
LINE UP
END
```

Rules:

- At most one `PROMPT` per response.
- `PROMPT` may not accompany `LINE DROP` — a dropped line asks nothing.
- A response carrying a `CALL` continuation omits `PROMPT`; the program is not
  ready for input. (`SEARCHING...` therefore correctly shows no prompt.)
- Absent `PROMPT`, renderers behave as today.

Harness:

- `emulator/node/app/systemwire.py` parses the optional block.
- The node host (`nodehost.py`) and the web bridge (`main.py` system path)
  deliver it with the existing `prompt` envelope kind — the channel game
  prompts (`[TTT]>`) already use. `render-tty.ts` already renders prompt
  envelopes on the input line, cursor after the text; no renderer change.

Programs — each system moves its asking-line out of `DISPLAY` into `PROMPT`:

| System | Prompts |
|---|---|
| school | `PASSWORD:`, `SELECT:`, `STUDENT NAME:`, `GRADE ENTRY - STUDENT NAME:`, `COURSE:`, `NEW GRADE:`, `MORE - TYPE M` |
| pactel | `TEST:` |
| protovision | `COMMAND:` |
| airline | `READY:` (new — today the greeting just says "AGENT SET READY") |
| reference | `>` (new) |

All five systems' golden fixtures regenerate; every diff reviewed line-by-line
per CONTRIBUTING.md.

**Cross-repo:** SYSTEM/1 is documented in the engine repo (`real-wopr`,
`docs/systems.md`). After this lands: update those docs, re-pin `packs.lock`,
re-run the film evals — separate session in that repo.

## 3. Auto-uppercase at the terminal

`emulator/terminal/src/protocol.ts` `send()` uppercases outgoing text — one
line, shared by the CLI and the xterm.js renderer. Caveat, accepted: local echo
shows what was typed (lowercase); the wire carries uppercase. `pencil` now
works as the school password.

## 4. School menu clarity

`LIST NAME* OR COURSES PFX* FOR ROSTERS` becomes two menu lines:

```
LIST - STUDENT ROSTER (LIST A* TO FILTER)
COURSES - COURSE CATALOG (COURSES MA* TO FILTER)
```

`SELECT:` moves to `PROMPT` (§2). Menu `DISPLAY` counts change; school
fixtures regenerate once for both changes together.

## 5. Protovision: info screens + company page

Two commands join `L` in the existing 6502 dispatch style:

- **`I <n>`** — info page for catalog slot n: title, genre/players, dev status
  (`RELEASED` / `PRE-RELEASE`), release window, one-line dev note. Pre-release
  titles (VELDRAX, OBLICON) get teaser-thin pages — locked is locked.
  Bad index → `NO SUCH TITLE`.
- **`A`** — `PROTOVISION INC - SUNNYVALE CA`, street address, the
  (408) 555-0163 dial-in, distributor line, `NOW HIRING 6502 PROGRAMMERS`.

Greeting advertises the commands: `TYPE L TO LIST, I <N> FOR INFO, A FOR
ABOUT`. All content is RODATA strings; five titles stay five. New fixtures:
info-released, info-prerelease, info-bad-index, about.

## 6. PacTel: billing desk, persistent

Three commands join the test board, operating on the line under test:

- **`BAL`** — subscriber name + balance from committed `data/accounts.dat`
  (fixed-width flat records).
- **`HIST`** — call history from `data/calls.dat`: date, number called,
  minutes, charge. Dates are committed bytes; determinism holds.
- **`ADJ <amount>`** — adjusted balance for the line, e.g. `ADJ 0.00`.
  Adjustments ride `STATE` as `ADJ <line10> <amount>` lines. The manifest's
  node block declares `"state": "persistent"`, so adjustments survive
  hang-ups and restarts (the school-grades mechanism). Garbage amount → a
  period error message, line stays up.

`HELP` gains a `BILLING:` section. **Room to grow:** the `STATE` tag format is
chosen so the `ADJ` lines could move wholesale into a future `pactel-db` bus
store following school/school-db, if billing outgrows the test board; noted in
the `pactel.c` header too.

## Testing

- Golden fixtures regenerate for school, pactel, protovision, airline,
  reference; new fixtures for every new command including error paths.
- Harness changes (`systemwire.py`, node host, `protocol.ts`, `config.ts`)
  ride the emulator's own test suites.
- Gate: `make test` green, `tools/behavior.sh` green, plus a live dial-through
  of each changed system.

## Out of scope

- The WOPR node itself (`(311) 486-0623` — no period source yet, #112).
- More Protovision titles; an ordering/dealer flow.
- A `pactel-db` store (documented as the growth path only).
- Engine-repo doc/eval updates (follow-up session in `real-wopr`).
