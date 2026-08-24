# Union Marine Bank Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `systems/umb/`, a COBOL SYSTEM/1 back-office inquiry desk for the film's UNION MARINE BANK, dialable and listed in the phone book and war-dial sweep.

**Architecture:** One stateless COBOL-85 program per SYSTEM/1: read one request frame from stdin, write one response frame to stdout, exit. Session position lives entirely in the opaque two-character `STATE` line the bridge echoes back. Two `LINE SEQUENTIAL` flat files supply read-only account and transaction data.

**Tech Stack:** GnuCOBOL (`cobc -x -std=cobol85`), bash build wrapper, golden `.in`/`.out` fixtures run by `tools/test.sh`.

**Spec:** `docs/superpowers/specs/2026-08-23-union-marine-bank-design.md`

## Global Constraints

- **Wire protocol:** SYSTEM/1 (`../real-wopr/docs/systems.md` §2). Request `SYSTEM/1 <id> <COMMAND>` / `STATE <n>` / n lines / optional `INPUT <line>` / `END`. Response `SYSTEM/1 umb OK` / `STATE <m>` / m lines / `DISPLAY <k>` / k lines / optional `PROMPT <text>` / `LINE <UP|DROP>` / `END`.
- **System id is `umb`** everywhere — manifest, response frames, fixtures.
- **Determinism:** same request bytes ⇒ same response bytes. No wall clock, no randomness. (`CONTRIBUTING.md` §Determinism and period discipline.)
- **Period discipline:** COBOL-85 constructs only. Two GnuCOBOL facts that are not optional:
  - `-std=cobol85` disables device mnemonics, so stdin **must** be `ASSIGN TO "/dev/stdin"`. `ASSIGN TO KEYBOARD` opens a literal file named `KEYBOARD` and blocks forever.
  - `-std=cobol85` has **no `FUNCTION TRIM`** (a COBOL-2002 intrinsic). Trim by reference modification, as `reference.cob` does in `RTRIM-INPUT`.
- **No film assets or transcript text.** The banner's two lines are the ceiling.
- **Fidelity boundary:** only `UNION MARINE BANK` / `SOUTHWEST REGIONAL DATA CENTER` is shown in the film. Everything else is documented interpretation.
- **Fixture naming:** `tools/test.sh` requires any fixture whose name contains `error` to exit **non-zero**; every other fixture must exit **zero**.
- **Money is stored pre-formatted.** Balances and amounts are right-justified display strings in the data files, not numerics. The system is read-only and never computes, so this removes all rounding and edit-mask risk from the golden output.

## STATE encoding

One line, exactly two characters:

| Value | Meaning |
| --- | --- |
| `N0` | unauthenticated, 0 failed attempts |
| `N1` / `N2` | unauthenticated, 1 / 2 failed attempts |
| `Y0` | authenticated |

Every `LINE DROP` response carries `STATE 0` (no state lines) — the line is gone.

## Data record layouts

`data/accounts.dat`, `PIC X(80)`, `LINE SEQUENTIAL`:

| Columns | Field | Example |
| --- | --- | --- |
| 1–10 | account number | `4471-08822` |
| 11–18 | type | `CHECKING` |
| 19–42 | name | `ANDERSSON, K` |
| 43–45 | branch | `042` |
| 46–57 | branch city | `SEATTLE` |
| 58–67 | balance, right-justified | `  1,284.55` |
| 68–77 | hold, right-justified | `      0.00` |

`data/history.dat`, `PIC X(80)`, `LINE SEQUENTIAL`, grouped by account, most recent first within an account:

| Columns | Field | Example |
| --- | --- | --- |
| 1–10 | account number | `4471-08822` |
| 11–15 | date | `11-03` |
| 16–36 | description | `DEPOSIT` |
| 37–46 | amount, right-justified | `    920.00` |

## File Structure

| File | Responsibility |
| --- | --- |
| `systems/umb/umb.cob` | the whole program: parse, dispatch, all displays |
| `systems/umb/data/accounts.dat` | account master, read-only |
| `systems/umb/data/history.dat` | transaction history, read-only |
| `systems/umb/harness/manifest.json` | id/title/language/binary/number — the authority |
| `systems/umb/harness/build.sh` | `cobc` + chdir wrapper |
| `systems/umb/harness/tests/*.in|.out` | golden fixtures |
| `systems/umb/README.md` | shown vs interpreted |
| `pack.json` | regenerated, never hand-edited |
| `emulator/web/home-terminal/app/sims.ts` | phone-book + wardial listing |
| `CREDITS.md` | banner sources |

---

### Task 1: Scaffold, CONNECT banner, and the build

**Files:**
- Create: `systems/umb/umb.cob`
- Create: `systems/umb/harness/manifest.json`
- Create: `systems/umb/harness/build.sh`
- Test: `systems/umb/harness/tests/01-connect.in`, `systems/umb/harness/tests/01-connect.out`

**Interfaces:**
- Consumes: nothing.
- Produces: the request-parsing paragraphs `READ-LINE`, `RTRIM-INPUT`, and working-storage fields `WS-CMD PIC X(16)`, `WS-INPUT PIC X(240)`, `WS-INPUT-LEN PIC 9(4)`, `WS-HAVE-INPUT PIC X`, `WS-AUTH PIC X`, `WS-TRIES PIC 9` — every later task dispatches from these.

- [ ] **Step 1: Write the failing test**

`systems/umb/harness/tests/01-connect.in`:

```
SYSTEM/1 umb CONNECT
STATE 0
END
```

`systems/umb/harness/tests/01-connect.out`:

```
SYSTEM/1 umb OK
STATE 1
N0
DISPLAY 3
UNION MARINE BANK
SOUTHWEST REGIONAL DATA CENTER
AUTHORIZED ACCESS ONLY - TYPE NEWS FOR SERVICE BULLETIN
PROMPT LOGON:
LINE UP
END
```

- [ ] **Step 2: Run test to verify it fails**

Run: `tools/test.sh systems`
Expected: `SKIP umb/01-connect — no binary (build it first)` — the program does not exist yet.

- [ ] **Step 3: Write the manifest**

`systems/umb/harness/manifest.json`:

```json
{
  "id": "umb",
  "title": "UNION MARINE BANK",
  "language": "cobol",
  "binary": "umb",
  "number": "(408) 555-0164",
  "timeout_s": 2,
  "node": {
    "networks": {
      "pstn": {
        "address": "(408) 555-0164",
        "protocol": "SYSTEM/1"
      }
    }
  }
}
```

Note there is no `node.state` key: the system is read-only and persists nothing.

- [ ] **Step 4: Write the build script**

`systems/umb/harness/build.sh` — the wrapper `chdir`s to the program folder so the relative `ASSIGN TO "data/..."` paths resolve wherever the host spawns the binary. Copied in shape from `systems/airline/harness/build.sh`:

```bash
#!/usr/bin/env bash
# Build the Union Marine Bank system. Source is ../umb.cob; the compiled
# binary lands in bin/umb-cbl, and bin/umb is a wrapper that chdirs to the
# program's folder first so the COBOL's relative ASSIGNs ("data/accounts.dat",
# "data/history.dat") resolve no matter where the host spawns it from — the
# same wrapper pattern airline and the BASIC systems use. Requires GnuCOBOL.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p bin
cobc -x -std=cobol85 -O -o "bin/umb-cbl" "../umb.cob"
cat > bin/umb <<'WRAP'
#!/usr/bin/env bash
set -uo pipefail
d="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$d"
exec "$d/harness/bin/umb-cbl"
WRAP
chmod +x bin/umb
echo "built systems/umb -> harness/bin/umb"
```

Then: `chmod +x systems/umb/harness/build.sh`

- [ ] **Step 5: Write the program skeleton**

`systems/umb/umb.cob`. The request parser is the same shape as `systems/reference/reference.cob` — read it first; the comments there explain both GnuCOBOL workarounds.

```cobol
       IDENTIFICATION DIVISION.
       PROGRAM-ID. UMB.
      * UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER.
      * SYSTEM/1 back-office inquiry desk (docs/systems.md). Reads one
      * request on stdin, writes one response on stdout. Read-only:
      * nothing here mutates account data, so STATE carries only the
      * session's position -- "N0".."N2" unauthenticated with a failed
      * attempt count, "Y0" authenticated.
      *
      * The film shows the two banner lines and nothing else; the logon,
      * the bulletin and every account are documented interpretation.
      * See README.md and the spec.
       ENVIRONMENT DIVISION.
       INPUT-OUTPUT SECTION.
       FILE-CONTROL.
      *    See reference.cob: -std=cobol85 disables device mnemonics, so
      *    stdin must be assigned to the device path or READ blocks on a
      *    literal file named KEYBOARD. Host plumbing only.
           SELECT SYS-IN ASSIGN TO "/dev/stdin"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-FS.
       DATA DIVISION.
       FILE SECTION.
       FD  SYS-IN.
       01  IN-REC              PIC X(256).
       WORKING-STORAGE SECTION.
       01  WS-FS               PIC XX.
       01  WS-CMD              PIC X(16) VALUE SPACES.
       01  WS-STATE-N          PIC 9(4)  VALUE 0.
       01  WS-INPUT            PIC X(240) VALUE SPACES.
       01  WS-INPUT-LEN        PIC 9(4)  VALUE 0.
       01  WS-HAVE-INPUT       PIC X     VALUE "N".
       01  WS-AUTH             PIC X     VALUE "N".
       01  WS-TRIES            PIC 9     VALUE 0.
       01  WS-TRIES-D          PIC 9.
       01  WS-TOK              PIC X(16).
       01  WS-EOF              PIC X     VALUE "N".
       01  WS-I                PIC 9(4).
       01  WS-J                PIC 9(4).
       PROCEDURE DIVISION.
       MAIN.
           OPEN INPUT SYS-IN
           PERFORM READ-LINE
           IF WS-EOF = "Y" PERFORM PROTOCOL-ERROR END-IF
           UNSTRING IN-REC DELIMITED BY ALL SPACES
               INTO WS-TOK WS-TOK WS-CMD
           END-UNSTRING
           PERFORM READ-LINE
           MOVE FUNCTION NUMVAL(IN-REC(7:4)) TO WS-STATE-N
           IF WS-STATE-N > 0
               PERFORM READ-LINE
               MOVE IN-REC(1:1) TO WS-AUTH
               MOVE FUNCTION NUMVAL(IN-REC(2:1)) TO WS-TRIES
               PERFORM VARYING WS-I FROM 2 BY 1
                       UNTIL WS-I > WS-STATE-N
                   PERFORM READ-LINE
               END-PERFORM
           END-IF
           PERFORM READ-LINE
           IF IN-REC(1:6) = "INPUT "
               MOVE IN-REC(7:240) TO WS-INPUT
               MOVE "Y" TO WS-HAVE-INPUT
               PERFORM READ-LINE
           END-IF
           CLOSE SYS-IN
           EVALUATE WS-CMD
               WHEN "CONNECT" PERFORM DO-CONNECT
               WHEN "INPUT"   PERFORM DO-INPUT
               WHEN OTHER     PERFORM PROTOCOL-ERROR
           END-EVALUATE
           STOP RUN.
       READ-LINE.
           READ SYS-IN
               AT END MOVE "Y" TO WS-EOF MOVE SPACES TO IN-REC
           END-READ.
       RTRIM-INPUT.
      *    No FUNCTION TRIM under -std=cobol85; find the last non-space.
           MOVE 240 TO WS-J
           PERFORM UNTIL WS-J = 0 OR WS-INPUT(WS-J:1) NOT = SPACE
               SUBTRACT 1 FROM WS-J
           END-PERFORM
           MOVE WS-J TO WS-INPUT-LEN
           IF WS-INPUT-LEN = 0
               MOVE 1 TO WS-INPUT-LEN
           END-IF.
       DO-CONNECT.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 1"
           DISPLAY "N0"
           DISPLAY "DISPLAY 3"
           DISPLAY "UNION MARINE BANK"
           DISPLAY "SOUTHWEST REGIONAL DATA CENTER"
           DISPLAY "AUTHORIZED ACCESS ONLY - TYPE NEWS FOR SERVICE BULLE"
               "TIN"
           DISPLAY "PROMPT LOGON:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-INPUT.
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
           PERFORM RTRIM-INPUT
           PERFORM PROTOCOL-ERROR.
       PROTOCOL-ERROR.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "PROTOCOL ERROR"
           DISPLAY "LINE DROP"
           DISPLAY "END"
           STOP RUN GIVING 1.
```

`DO-INPUT` ending in `PROTOCOL-ERROR` is deliberate scaffolding: Task 2 replaces its body. No fixture exercises `INPUT` yet.

- [ ] **Step 6: Build and run the test**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: `umb/01-connect` passes; every other system still passes.

If the COBOL source line for the `AUTHORIZED ACCESS ONLY` banner exceeds column 72, split it with a continued literal exactly as shown above — COBOL-85 is column-sensitive and `cobc` will truncate silently otherwise. Verify the emitted line matches the fixture byte for byte.

- [ ] **Step 7: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): SYSTEM/1 scaffold and the film's banner"
```

---

### Task 2: The logon wall

**Files:**
- Modify: `systems/umb/umb.cob` (replace `DO-INPUT`, add `DO-NEWS`, `DO-LOGON`)
- Test: `systems/umb/harness/tests/02-news.in|.out`, `03-logon-bad.in|.out`, `04-logon-bad-2.in|.out`, `05-logon-bad-3-drop.in|.out`, `06-logon-ok.in|.out`, `07-early-command.in|.out`

**Interfaces:**
- Consumes: `WS-AUTH`, `WS-TRIES`, `WS-INPUT`, `WS-INPUT-LEN`, `RTRIM-INPUT` from Task 1.
- Produces: `DO-AUTHED` — the paragraph Tasks 3–6 extend with authenticated commands. After this task it exists and answers everything with `INVALID COMMAND - TYPE HELP`.

- [ ] **Step 1: Write the failing tests**

`02-news.in` (state `N1`: the bulletin is readable mid-attempt and must not consume an attempt):

```
SYSTEM/1 umb INPUT
STATE 1
N1
INPUT NEWS
END
```

`02-news.out`:

```
SYSTEM/1 umb OK
STATE 1
N1
DISPLAY 4
UMB DATA CENTER - SERVICE BULLETIN 83-114
  BATCH WINDOW MOVED TO 0200 EFFECTIVE 11-14.
  FIELD SERVICE LOGON UMBFS1 REMAINS ENABLED PENDING
  REMOVAL BY DATA CENTER OPERATIONS.
PROMPT LOGON:
LINE UP
END
```

`03-logon-bad.in`:

```
SYSTEM/1 umb INPUT
STATE 1
N0
INPUT DAVID
END
```

`03-logon-bad.out`:

```
SYSTEM/1 umb OK
STATE 1
N1
DISPLAY 1
LOGON REJECTED - ATTEMPT 1 OF 3
PROMPT LOGON:
LINE UP
END
```

`04-logon-bad-2.in` is identical with `STATE` line `N1` and `INPUT JOSHUA`; `04-logon-bad-2.out` is identical with state `N2` and `ATTEMPT 2 OF 3`.

`05-logon-bad-3-drop.in`:

```
SYSTEM/1 umb INPUT
STATE 1
N2
INPUT FALKEN
END
```

`05-logon-bad-3-drop.out`:

```
SYSTEM/1 umb OK
STATE 0
DISPLAY 3
LOGON REJECTED - ATTEMPT 3 OF 3
SECURITY VIOLATION LOGGED
CONTACT DATA CENTER OPERATIONS
LINE DROP
END
```

`06-logon-ok.in`:

```
SYSTEM/1 umb INPUT
STATE 1
N1
INPUT UMBFS1
END
```

`06-logon-ok.out`:

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 2
UMB INQUIRY SUBSYSTEM  REL 3.2
FIELD SERVICE - READ ONLY
PROMPT READY:
LINE UP
END
```

`07-early-command.in` — the spec's resolved ambiguity: an inquiry command before logon is consumed as a failed attempt and never diagnosed.

```
SYSTEM/1 umb INPUT
STATE 1
N0
INPUT ACCT 4471-08822
END
```

`07-early-command.out`:

```
SYSTEM/1 umb OK
STATE 1
N1
DISPLAY 1
LOGON REJECTED - ATTEMPT 1 OF 3
PROMPT LOGON:
LINE UP
END
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/test.sh systems`
Expected: all six new fixtures FAIL — `DO-INPUT` still returns `PROTOCOL ERROR` with a non-zero exit, and none of these names contain `error`, so `tools/test.sh` reports both the exit code and the diff.

- [ ] **Step 3: Implement the wall**

Replace `DO-INPUT` in `systems/umb/umb.cob` and add the paragraphs below:

```cobol
       DO-INPUT.
           IF WS-HAVE-INPUT NOT = "Y"
               PERFORM PROTOCOL-ERROR
           END-IF
           PERFORM RTRIM-INPUT
           IF WS-AUTH = "Y"
               PERFORM DO-AUTHED
           ELSE
               IF WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "NEWS"
                   PERFORM DO-NEWS
               ELSE
                   PERFORM DO-LOGON
               END-IF
           END-IF.
       DO-NEWS.
      *    Readable mid-attempt and never counts against the three: it
      *    is a notice board, not a guess. It is also the only way in --
      *    the field-service logon it leaks is the interpretation the
      *    spec turns on.
           MOVE WS-TRIES TO WS-TRIES-D
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 1"
           DISPLAY "N" WS-TRIES-D
           DISPLAY "DISPLAY 4"
           DISPLAY "UMB DATA CENTER - SERVICE BULLETIN 83-114"
           DISPLAY "  BATCH WINDOW MOVED TO 0200 EFFECTIVE 11-14."
           DISPLAY "  FIELD SERVICE LOGON UMBFS1 REMAINS ENABLED PENDING"
           DISPLAY "  REMOVAL BY DATA CENTER OPERATIONS."
           DISPLAY "PROMPT LOGON:"
           DISPLAY "LINE UP"
           DISPLAY "END".
       DO-LOGON.
           IF WS-INPUT-LEN = 6 AND WS-INPUT(1:6) = "UMBFS1"
               DISPLAY "SYSTEM/1 umb OK"
               DISPLAY "STATE 1"
               DISPLAY "Y0"
               DISPLAY "DISPLAY 2"
               DISPLAY "UMB INQUIRY SUBSYSTEM  REL 3.2"
               DISPLAY "FIELD SERVICE - READ ONLY"
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           ELSE
               ADD 1 TO WS-TRIES
               MOVE WS-TRIES TO WS-TRIES-D
               IF WS-TRIES < 3
                   DISPLAY "SYSTEM/1 umb OK"
                   DISPLAY "STATE 1"
                   DISPLAY "N" WS-TRIES-D
                   DISPLAY "DISPLAY 1"
                   DISPLAY "LOGON REJECTED - ATTEMPT " WS-TRIES-D
                       " OF 3"
                   DISPLAY "PROMPT LOGON:"
                   DISPLAY "LINE UP"
                   DISPLAY "END"
               ELSE
                   DISPLAY "SYSTEM/1 umb OK"
                   DISPLAY "STATE 0"
                   DISPLAY "DISPLAY 3"
                   DISPLAY "LOGON REJECTED - ATTEMPT 3 OF 3"
                   DISPLAY "SECURITY VIOLATION LOGGED"
                   DISPLAY "CONTACT DATA CENTER OPERATIONS"
                   DISPLAY "LINE DROP"
                   DISPLAY "END"
               END-IF
           END-IF.
       DO-AUTHED.
           PERFORM SAY-INVALID.
       SAY-INVALID.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 1"
           DISPLAY "Y0"
           DISPLAY "DISPLAY 1"
           DISPLAY "INVALID COMMAND - TYPE HELP"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
```

`DISPLAY "N" WS-TRIES-D` concatenates without a separator, producing exactly `N1`. Confirm this in the built binary rather than assuming — if `cobc` emits a space, use a two-character `WS-STATE-OUT PIC XX` built with `STRING`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: all seven `umb` fixtures pass.

- [ ] **Step 5: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): the logon wall and the bulletin that opens it"
```

---

### Task 3: HELP and the authenticated dispatch

**Files:**
- Modify: `systems/umb/umb.cob` (`DO-AUTHED`, add `DO-HELP`)
- Test: `systems/umb/harness/tests/08-help.in|.out`, `09-invalid.in|.out`

**Interfaces:**
- Consumes: `DO-AUTHED`, `SAY-INVALID` from Task 2.
- Produces: the `EVALUATE`-style dispatch inside `DO-AUTHED` that Tasks 4–6 add branches to, keyed on `WS-INPUT(1:4)`.

- [ ] **Step 1: Write the failing tests**

`08-help.in` — `STATE` line `Y0`, `INPUT HELP`. `08-help.out`:

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 5
UMB INQUIRY COMMANDS:
  ACCT <NUMBER>   ACCOUNT SUMMARY
  HIST <NUMBER>   RECENT ACTIVITY
  HELP            THIS LIST
  BYE             SIGN OFF
PROMPT READY:
LINE UP
END
```

`09-invalid.in` — `STATE` line `Y0`, `INPUT WITHDRAW 100`. `09-invalid.out`:

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 1
INVALID COMMAND - TYPE HELP
PROMPT READY:
LINE UP
END
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/test.sh systems`
Expected: `umb/08-help` FAILS (it currently gets `INVALID COMMAND`). `umb/09-invalid` already PASSES — `DO-AUTHED` answers everything that way today. That is fine and expected; it is the regression guard for Task 3's dispatch.

- [ ] **Step 3: Implement the dispatch**

```cobol
       DO-AUTHED.
           EVALUATE TRUE
               WHEN WS-INPUT-LEN = 4 AND WS-INPUT(1:4) = "HELP"
                   PERFORM DO-HELP
               WHEN OTHER
                   PERFORM SAY-INVALID
           END-EVALUATE.
       DO-HELP.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 1"
           DISPLAY "Y0"
           DISPLAY "DISPLAY 5"
           DISPLAY "UMB INQUIRY COMMANDS:"
           DISPLAY "  ACCT <NUMBER>   ACCOUNT SUMMARY"
           DISPLAY "  HIST <NUMBER>   RECENT ACTIVITY"
           DISPLAY "  HELP            THIS LIST"
           DISPLAY "  BYE             SIGN OFF"
           DISPLAY "PROMPT READY:"
           DISPLAY "LINE UP"
           DISPLAY "END".
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: all nine `umb` fixtures pass.

- [ ] **Step 5: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): HELP and the authenticated command dispatch"
```

---

### Task 4: Account data and ACCT

**Files:**
- Create: `systems/umb/data/accounts.dat`
- Modify: `systems/umb/umb.cob` (add `ACCT-IN` file, `DO-ACCT`, `FIND-ACCT`)
- Test: `systems/umb/harness/tests/10-acct.in|.out`, `11-acct-unknown.in|.out`

**Interfaces:**
- Consumes: the `DO-AUTHED` dispatch from Task 3.
- Produces: `WS-ARG PIC X(10)` (the account number parsed from the command tail) and `WS-FOUND PIC X`, both reused by Task 5's `HIST`.

- [ ] **Step 1: Write the data file**

`systems/umb/data/accounts.dat` — column positions are in this plan's header. Write exactly 40 records; the three below are the ones the fixtures use, so they must appear verbatim. Invent the remaining 37 as Seattle-area names in the same format. **No film characters.**

```
4471-08822CHECKINGANDERSSON, K           042SEATTLE       1,284.55      0.00
4471-09104SAVINGS OKONKWO, T             042SEATTLE         612.10    100.00
4471-11730CHECKINGVANTERPOOL, M          117TACOMA         8,904.21      0.00
```

Verify alignment before moving on: `awk '{ if (length($0) != 77) print NR": "length($0) }' systems/umb/data/accounts.dat` must print nothing.

- [ ] **Step 2: Write the failing tests**

`10-acct.in` — `STATE` line `Y0`, `INPUT ACCT 4471-08822`. `10-acct.out`:

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 5
ACCT   4471-08822  CHECKING
NAME   ANDERSSON, K
BRANCH 042  SEATTLE
BAL      1,284.55
HOLD         0.00
PROMPT READY:
LINE UP
END
```

`11-acct-unknown.in` — `STATE` line `Y0`, `INPUT ACCT 9999-00000`. `11-acct-unknown.out`:

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 1
ACCOUNT NOT ON FILE
PROMPT READY:
LINE UP
END
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `tools/test.sh systems`
Expected: both FAIL with `INVALID COMMAND - TYPE HELP`.

- [ ] **Step 4: Implement ACCT**

Add to `FILE-CONTROL`, mirroring `airline.cob`'s data-file SELECTs:

```cobol
           SELECT ACCT-IN ASSIGN TO "data/accounts.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-AFS.
```

Add to `FILE SECTION`:

```cobol
       FD  ACCT-IN.
       01  ACCT-REC            PIC X(80).
```

Add to `WORKING-STORAGE`:

```cobol
       01  WS-AFS              PIC XX.
       01  WS-ARG              PIC X(10) VALUE SPACES.
       01  WS-FOUND            PIC X     VALUE "N".
       01  WS-AEOF             PIC X     VALUE "N".
       01  WS-HIT              PIC X(80) VALUE SPACES.
```

Add the dispatch branch to `DO-AUTHED`, before `WHEN OTHER`:

```cobol
               WHEN WS-INPUT-LEN > 5 AND WS-INPUT(1:5) = "ACCT "
                   MOVE WS-INPUT(6:10) TO WS-ARG
                   PERFORM FIND-ACCT
                   PERFORM DO-ACCT
```

Add the paragraphs:

```cobol
       FIND-ACCT.
      *    Sequential scan, the period-correct shape for a LINE
      *    SEQUENTIAL master: no indexed files, no sort.
           MOVE "N" TO WS-FOUND
           MOVE "N" TO WS-AEOF
           OPEN INPUT ACCT-IN
           PERFORM UNTIL WS-AEOF = "Y" OR WS-FOUND = "Y"
               READ ACCT-IN
                   AT END MOVE "Y" TO WS-AEOF
                   NOT AT END
                       IF ACCT-REC(1:10) = WS-ARG
                           MOVE ACCT-REC TO WS-HIT
                           MOVE "Y" TO WS-FOUND
                       END-IF
               END-READ
           END-PERFORM
           CLOSE ACCT-IN.
       DO-ACCT.
           IF WS-FOUND NOT = "Y"
               DISPLAY "SYSTEM/1 umb OK"
               DISPLAY "STATE 1"
               DISPLAY "Y0"
               DISPLAY "DISPLAY 1"
               DISPLAY "ACCOUNT NOT ON FILE"
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           ELSE
               DISPLAY "SYSTEM/1 umb OK"
               DISPLAY "STATE 1"
               DISPLAY "Y0"
               DISPLAY "DISPLAY 5"
               DISPLAY "ACCT   " WS-HIT(1:10) "  " WS-HIT(11:8)
               DISPLAY "NAME   " WS-HIT(19:24)
               DISPLAY "BRANCH " WS-HIT(43:3) "  " WS-HIT(46:12)
               DISPLAY "BAL    " WS-HIT(58:10)
               DISPLAY "HOLD   " WS-HIT(68:10)
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
```

`WS-HIT(19:24)` and `WS-HIT(46:12)` are fixed-width and space-padded, so the emitted lines carry trailing spaces. The fixture `.out` files must contain those trailing spaces byte for byte — `tools/test.sh` diffs exactly. Generate the `.out` by running the binary and inspecting with `cat -A` before committing it as golden.

- [ ] **Step 5: Run tests to verify they pass**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: all eleven `umb` fixtures pass.

- [ ] **Step 6: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): the account master and ACCT inquiry"
```

---

### Task 5: Transaction history and HIST

**Files:**
- Create: `systems/umb/data/history.dat`
- Modify: `systems/umb/umb.cob` (add `HIST-IN` file, `DO-HIST`)
- Test: `systems/umb/harness/tests/12-hist.in|.out`, `13-hist-unknown.in|.out`

**Interfaces:**
- Consumes: `WS-ARG`, `WS-FOUND`, `FIND-ACCT` from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the data file**

`systems/umb/data/history.dat`, layout in this plan's header. ~150 records grouped by account, newest first within an account. The three below are fixture-critical and must appear verbatim, contiguously:

```
4471-0882211-03DEPOSIT                  920.00
4471-0882211-01CHECK 1042              -118.45
4471-0882210-28DEPOSIT                1,040.00
```

Verify: `awk '{ if (length($0) != 46) print NR": "length($0) }' systems/umb/data/history.dat` must print nothing.

- [ ] **Step 2: Write the failing tests**

`12-hist.in` — `STATE` line `Y0`, `INPUT HIST 4471-08822`. `12-hist.out` (`DISPLAY` count is 1 header + 3 rows):

```
SYSTEM/1 umb OK
STATE 1
Y0
DISPLAY 4
DATE   DESCRIPTION            AMOUNT
11-03  DEPOSIT                920.00
11-01  CHECK 1042            -118.45
10-28  DEPOSIT              1,040.00
PROMPT READY:
LINE UP
END
```

`13-hist-unknown.in` — `STATE` line `Y0`, `INPUT HIST 9999-00000`. `13-hist-unknown.out` is `ACCOUNT NOT ON FILE`, identical in shape to `11-acct-unknown.out`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `tools/test.sh systems`
Expected: both FAIL with `INVALID COMMAND - TYPE HELP`.

- [ ] **Step 4: Implement HIST**

`HIST` checks the account exists via `FIND-ACCT` first, so an unknown account gets `ACCOUNT NOT ON FILE` rather than an empty list. The row count is not known until the file is scanned, so buffer the rows before emitting the `DISPLAY` header — the same technique `airline.cob` uses for its paged listing.

Add to `FILE-CONTROL` / `FILE SECTION` / `WORKING-STORAGE`:

```cobol
           SELECT HIST-IN ASSIGN TO "data/history.dat"
               ORGANIZATION IS LINE SEQUENTIAL
               FILE STATUS IS WS-HFS.
       FD  HIST-IN.
       01  HIST-REC            PIC X(80).
       01  WS-HFS              PIC XX.
       01  WS-HEOF             PIC X     VALUE "N".
       01  WS-ROWS             PIC 9(3)  VALUE 0.
       01  WS-ROW-D            PIC Z(2)9.
       01  WS-RSTART           PIC 9(4)  VALUE 0.
       01  WS-RLEN             PIC 9(4)  VALUE 0.
       01  WS-BUF.
           05  WS-BUF-ROW      PIC X(46) OCCURS 40 TIMES.
       01  WS-K                PIC 9(3).
```

Dispatch branch, before `WHEN OTHER`:

```cobol
               WHEN WS-INPUT-LEN > 5 AND WS-INPUT(1:5) = "HIST "
                   MOVE WS-INPUT(6:10) TO WS-ARG
                   PERFORM FIND-ACCT
                   PERFORM DO-HIST
```

```cobol
       DO-HIST.
           IF WS-FOUND NOT = "Y"
               DISPLAY "SYSTEM/1 umb OK"
               DISPLAY "STATE 1"
               DISPLAY "Y0"
               DISPLAY "DISPLAY 1"
               DISPLAY "ACCOUNT NOT ON FILE"
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           ELSE
               MOVE 0 TO WS-ROWS
               MOVE "N" TO WS-HEOF
               OPEN INPUT HIST-IN
               PERFORM UNTIL WS-HEOF = "Y" OR WS-ROWS = 40
                   READ HIST-IN
                       AT END MOVE "Y" TO WS-HEOF
                       NOT AT END
                           IF HIST-REC(1:10) = WS-ARG
                               ADD 1 TO WS-ROWS
                               MOVE HIST-REC(11:46)
                                   TO WS-BUF-ROW(WS-ROWS)
                           END-IF
                   END-READ
               END-PERFORM
               CLOSE HIST-IN
               COMPUTE WS-ROWS = WS-ROWS + 1
               MOVE WS-ROWS TO WS-ROW-D
               PERFORM LTRIM-ROWS
               COMPUTE WS-ROWS = WS-ROWS - 1
               DISPLAY "SYSTEM/1 umb OK"
               DISPLAY "STATE 1"
               DISPLAY "Y0"
               DISPLAY "DISPLAY " WS-ROW-D(WS-RSTART:WS-RLEN)
               DISPLAY "DATE   DESCRIPTION            AMOUNT"
               PERFORM VARYING WS-K FROM 1 BY 1 UNTIL WS-K > WS-ROWS
                   DISPLAY WS-BUF-ROW(WS-K)(1:5) "  "
                       WS-BUF-ROW(WS-K)(6:21) WS-BUF-ROW(WS-K)(27:10)
               END-PERFORM
               DISPLAY "PROMPT READY:"
               DISPLAY "LINE UP"
               DISPLAY "END"
           END-IF.
       LTRIM-ROWS.
      *    WS-ROW-D is PIC Z(2)9, left-padded with spaces.
           MOVE 1 TO WS-RSTART
           PERFORM UNTIL WS-RSTART > 3
                   OR WS-ROW-D(WS-RSTART:1) NOT = SPACE
               ADD 1 TO WS-RSTART
           END-PERFORM
           COMPUTE WS-RLEN = 4 - WS-RSTART.
```

The 40-row `OCCURS` cap is deliberate: no account in `history.dat` should exceed it, and a hard bound keeps the response size predictable at 600 baud. Keep every account under 40 transactions when writing the data.

- [ ] **Step 5: Run tests to verify they pass**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: all thirteen `umb` fixtures pass. Check the emitted row spacing with `cat -A` and make the golden `.out` match exactly.

- [ ] **Step 6: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): transaction history and HIST inquiry"
```

---

### Task 6: BYE, oversize input, and the protocol error

**Files:**
- Modify: `systems/umb/umb.cob` (add `DO-BYE`)
- Test: `systems/umb/harness/tests/14-bye.in|.out`, `15-oversize.in|.out`, `16-protocol-error.in|.out`

**Interfaces:**
- Consumes: the `DO-AUTHED` dispatch.
- Produces: nothing.

- [ ] **Step 1: Write the failing tests**

`14-bye.in` — `STATE` line `Y0`, `INPUT BYE`. `14-bye.out`:

```
SYSTEM/1 umb OK
STATE 0
DISPLAY 1
UMB INQUIRY SUBSYSTEM - SESSION ENDED
LINE DROP
END
```

`15-oversize.in` — `STATE` line `Y0` and an `INPUT` line of 300 `X` characters. The parser's `WS-INPUT PIC X(240)` truncates, so the result is `INVALID COMMAND`; the point of the fixture is that an over-long line cannot crash or corrupt the frame. `15-oversize.out` is identical to `09-invalid.out`.

`16-protocol-error.in` — an `INPUT` command with no `INPUT` line, which SYSTEM/1 §2.3 makes malformed. The name contains `error`, so `tools/test.sh` **requires a non-zero exit**:

```
SYSTEM/1 umb INPUT
STATE 1
Y0
END
```

`16-protocol-error.out`:

```
SYSTEM/1 umb OK
STATE 0
DISPLAY 1
PROTOCOL ERROR
LINE DROP
END
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `tools/test.sh systems`
Expected: `14-bye` FAILS with `INVALID COMMAND`. `15-oversize` and `16-protocol-error` should already PASS — both paths exist from Task 1. Confirm that rather than assuming it; if `15-oversize` fails, the parser is mishandling long lines and that is a real bug to fix here.

- [ ] **Step 3: Implement BYE**

Dispatch branch, before `WHEN OTHER`:

```cobol
               WHEN WS-INPUT-LEN = 3 AND WS-INPUT(1:3) = "BYE"
                   PERFORM DO-BYE
```

```cobol
       DO-BYE.
      *    STATE 0 and LINE DROP: the line is gone. The display has to
      *    reach the visitor before the carrier drops, which is the
      *    relay's job since #62 -- at 600 baud this sign-off is exactly
      *    the case that used to be discarded.
           DISPLAY "SYSTEM/1 umb OK"
           DISPLAY "STATE 0"
           DISPLAY "DISPLAY 1"
           DISPLAY "UMB INQUIRY SUBSYSTEM - SESSION ENDED"
           DISPLAY "LINE DROP"
           DISPLAY "END".
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `systems/umb/harness/build.sh && tools/test.sh systems`
Expected: all sixteen `umb` fixtures pass, and every other system still passes.

- [ ] **Step 5: Commit**

```bash
git add systems/umb
git commit -m "feat(umb): sign-off, oversize input, and the protocol error"
```

---

### Task 7: Make it dialable — index, phone book, docs

**Files:**
- Modify: `pack.json` (regenerated, never hand-edited)
- Modify: `emulator/web/home-terminal/app/sims.ts:34-40`
- Create: `systems/umb/README.md`
- Modify: `CREDITS.md`

**Interfaces:**
- Consumes: `systems/umb/harness/manifest.json` from Task 1 — the generator's only input.
- Produces: a dialable, listed system.

- [ ] **Step 1: Prove the index is currently stale**

Run: `python3 tools/gen-dial-directory.py --check`
Expected: non-zero exit — `umb` has a manifest with a `number` but `pack.json` has not been regenerated.

- [ ] **Step 2: Regenerate the index**

Run: `python3 tools/gen-dial-directory.py`
Then: `python3 tools/gen-dial-directory.py --check` — expected exit 0.

Read the `pack.json` diff line by line before continuing. It should add exactly one `programs[]` entry and one dial-directory entry, both for `umb`. Anything else means the generator picked up an unrelated drift.

- [ ] **Step 3: Prove the web surface refuses an unlisted dialable system**

Run: `cd emulator/web && npm test`
Expected: FAIL — `sims.ts does not mention "umb", which is dialable`. This is the guard rail described in the spec §4 firing exactly as designed.

- [ ] **Step 4: List it in the phone book and the war-dial sweep**

In `emulator/web/home-terminal/app/sims.ts`, add to `LISTED` after the `pactel` entry:

```typescript
  { systemId: "umb", name: "UNION MARINE BANK", label: "BANK" },
```

`label` is the war-dial sweep's domain word, so this is also what puts the bank in the sweep — the thing issue #42 actually asked for.

- [ ] **Step 5: Run the web tests**

Run: `cd emulator/web && npm test`
Expected: PASS.

- [ ] **Step 6: Write the system README**

`systems/umb/README.md` — the fidelity boundary is the whole point of this file:

```markdown
# systems/umb — Union Marine Bank

A COBOL back-office inquiry desk for the film's bank, on the SYSTEM/1 tier.
Answers `(408) 555-0164`.

## What is shown, and what is ours

The film shows one thing: a banner.

    UNION MARINE BANK - SOUTHWEST REGIONAL DATA CENTER

That line is the whole of the attestation (`CREDITS.md`) — where in the film it
appears, and what is said around it, are not attested here and are not claimed.
Everything below the banner is our documented interpretation, not a
reconstruction:

| Element | Provenance |
| --- | --- |
| The two banner lines | **shown** — the film |
| Logon prompt, rejection wording, the three-attempt limit | interpretation |
| The service bulletin, and the `UMBFS1` field-service logon it leaks | interpretation |
| `ACCT` / `HIST` / `HELP` / `BYE`, the subsystem name and release | interpretation |
| Every account, branch, balance and transaction | interpretation |

No account belongs to a film character. Inventing one would assert something
the film does not.

This is not a reconstruction of anyone else's bank. Andy Glenn's zompiexx
interpretation is acknowledged in `CREDITS.md` as attestation for the banner
text; his design is not reused here.

## Running it

    systems/umb/harness/build.sh
    tools/test.sh systems

Read-only: no command mutates the data files, and the manifest declares no
persistent node state.
```

- [ ] **Step 7: Credit the banner sources**

Add to `CREDITS.md`, in the style of the entries already there: the banner text is attested by `mw.rat.bz/wgterm` and Andy Glenn's zompiexx recreation, cited as evidence for a shown line, with the system itself written from scratch.

- [ ] **Step 8: Full verification**

Run: `make build && make test && python3 tools/gen-dial-directory.py --check`
Then: `cd emulator/web && npm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add pack.json emulator/web/home-terminal/app/sims.ts systems/umb/README.md CREDITS.md
git commit -m "feat(umb): dialable, listed, and in the war-dial sweep (#42)"
```

---

### Task 8: Engine-repo documentation (after the pack PR merges)

**This task runs in `../real-wopr`, not this repo.** Per the spec's sequencing, it lands in the same PR as the `packs.lock` re-pin, after the pack change is merged. `../real-wopr`'s own `AGENTS.md` governs it; this repo's rules do not apply there.

**Files:**
- Modify: `docs/period-systems.md` (language map row; Non-goals untouched)
- Modify: `docs/systems.md` (new §4.6)
- Modify: `packs.lock`, `HANDOFF.md`

- [ ] **Step 1: Amend the language map**

In `docs/period-systems.md`, the row reading:

```
| Bank, BBS, other 1983 systems | — | Andy Glenn's zompiexx interpretations; acknowledged, not copied | — | out of scope |
```

becomes two rows — the bank promoted, the rest unchanged:

```
| Union Marine Bank | COBOL | banking back-office ran COBOL under CICS | shown (banner) | ✅ built (2026-08-23) |
| BBS, other 1983 systems | — | Andy Glenn's zompiexx interpretations; acknowledged, not copied | — | out of scope |
```

Leave the Non-goals entry — "Copying Andy Glenn's specific system designs (bank / BBS / starwars / telstar)" — **exactly as written**. It is not contradicted: nothing was copied.

- [ ] **Step 1b: Amend the war-dial montage list**

`docs/fidelity-notes.md` §10 enumerates the montage's hits as a closed set of four — "the
airline, the school, Protovision, Pacific Telephone". This branch makes it five. Found by the
whole-branch review; without this the paired PR leaves a fidelity document stale.

- [ ] **Step 2: Document the system**

Add `docs/systems.md` §4.6 for `umb`, following §4.5 (PACTEL) in shape and length: what it is, its number, its command surface, and a pointer to the fidelity boundary in the pack's `systems/umb/README.md`.

- [ ] **Step 3: Re-pin and verify**

```bash
# packs.lock -> the merged pack commit
tools/import-programs.sh
.venv/bin/pip install -q -e "build/pack/emulator/node[dev]"
.venv/bin/python evals/run_evals.py
```

Expected: 14/14. The bank adds a dialable system but changes no film scenario, so a moved eval means something unintended happened — investigate rather than re-baseline.

- [ ] **Step 4: HANDOFF and commit**

Add a `Landed 2026-08-23` entry recording the promotion and the language-map correction, then commit and open the PR.

---

## Self-Review

**Spec coverage.** §1 The session → Tasks 1, 2, 3, 6. §2 Data → Tasks 4, 5. §3 Files → Task 1 (manifest, build) and Tasks 4–5 (data). §4 Integration → Task 7. §5 Documentation → Task 7 (pack) and Task 8 (engine). Testing → the fixture list is distributed across Tasks 1–6 and totals 16, inside the spec's 14–18. Sequencing → Task 8's preamble. No gaps.

**Placeholder scan.** Every code step carries real code. The two data files are the one place the plan specifies a *format* plus fixture-critical records rather than all 190 lines; the column tables and the `awk` width checks make that verifiable rather than vague.

**Type consistency.** `WS-ARG`, `WS-FOUND`, `FIND-ACCT` are defined in Task 4 and consumed by name in Task 5. `DO-AUTHED` is created in Task 2 and extended in Tasks 3–6. `SAY-INVALID` is defined in Task 2 and referenced in Task 3. `WS-TRIES-D` is declared in Task 1 and first used in Task 2. `WS-INPUT-LEN` and `RTRIM-INPUT` come from Task 1 and are used throughout.
