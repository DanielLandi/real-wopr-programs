# Six Pack Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the six approved improvements in `docs/superpowers/specs/2026-07-29-pack-improvements-design.md`: 1200-baud pstn, SYSTEM/1 `PROMPT` block end-to-end, terminal auto-uppercase, clearer school menu, Protovision info/about pages, PacTel persistent billing desk.

**Architecture:** Programs stay period (BASIC/C89/6502/COBOL, byte-exact golden fixtures); the harness is modern (Python 3.11 node host, TypeScript relay/terminal). The `PROMPT` block flows program → `systemwire.py` → new NODE/1 `PROMPT` frame → relay → `prompt` envelope (existing kind) → renderer. PacTel persistence reuses the host store mechanism school-db already uses (`"state": "persistent"`).

**Tech Stack:** bwBASIC, C89, ca65 (6502), GnuCOBOL, Python 3.11 + pytest, Node 23.6 + `node --test`.

## Global Constraints

- Work on branch `claude/pack-improvements`; merge via PR with CI green (repo CI has 9 jobs). Never commit to `main` directly.
- Programs: period-plausible constructs only (CONTRIBUTING.md). No wall clock, no unseeded randomness. Committed `data/` bytes are fine.
- Golden fixtures are the spec: after a deliberate behavior change, regenerate with `for f in tests/*.in; do bin/<binary> < "$f" > "${f%.in}.out"; done` from the program's `harness/` dir, then **review every diff line-by-line** before committing. Fixtures named `*error*` must exit non-zero.
- The harness never reaches inside a program; `STATE` stays opaque.
- No film assets or transcript text beyond what's already present.
- Test commands: `make test` (all fixtures), `tools/test.sh systems`, `tools/behavior.sh`; Python: `cd emulator/node && ../../.venv-or-system pytest tests/ -x -q` (use `python3 -m pytest`); TS: `cd emulator/relay && npm test` (same for `terminal`, `cli`).
- Commit style (from git log): `feat(systems): ...`, `test(node): ...`, `docs(...): ...`. End every commit message with the Co-Authored-By + Claude-Session trailer used on this branch's first commit.

---

### Task 1: Relay honors declared network baud; pstn → 1200

**Files:**
- Modify: `emulator/relay/src/network.ts:47-56` (`profileFor`)
- Modify: `emulator/relay/src/config.ts:54` (`surface_links["home-terminal"]`)
- Modify: `pack.json:11` (`networks.pstn.baud`)
- Modify: `README.md`, `emulator/README.md` (the "300 baud" mentions)
- Test: `emulator/relay/tests/network.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CONFIG.profiles` from `config.ts` (has `dialup-300`, `dialup-1200`, `leased-9600`, `internal-bus`, `off`).
- Produces: `profileFor(desc, mode)` now resolves `profiles[`${desc.kind}-${desc.baud}`]` when a declared baud matches a tuned profile, else falls back to the kind default. Later tasks rely on pstn shaping at 1200 baud.

- [ ] **Step 1: Write the failing tests** (append to `emulator/relay/tests/network.test.ts`, following its existing import style):

```ts
test("profileFor honors a declared baud that matches a tuned profile", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone", baud: 1200 }, "authentic");
  assert.equal(p.baud, 1200);
  assert.equal(p.handshake, "dialup");
});

test("profileFor without a declared baud keeps the kind default", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone" }, "authentic");
  assert.equal(p.baud, 300);
});

test("profileFor with an unmatched baud falls back to the kind default", () => {
  const p = profileFor(
    { name: "pstn", kind: "dialup", addressing: "phone", baud: 600 }, "authentic");
  assert.equal(p.baud, 300);
});
```

Import `profileFor` from `../src/network.ts` if the test file doesn't already.

- [ ] **Step 2: Run to verify the first test fails**

Run: `cd emulator/relay && npm test`
Expected: FAIL — declared-baud test gets 300, not 1200.

- [ ] **Step 3: Implement** — replace the body of `profileFor`:

```ts
/** Which link profile a network implies: a declared baud picks the matching
 * tuned profile when one exists ("dialup-1200"); otherwise the kind's
 * default. `fast` mode flattens them all. */
export function profileFor(desc: NetworkDescriptor, mode: CommsMode): LinkProfile {
  if (mode === "fast") return DEFAULT_CONFIG.profiles.off;
  const byKind: Record<NetworkDescriptor["kind"], string> = {
    dialup: "dialup-300",
    leased: "leased-9600",
    local: "internal-bus",
  };
  const tuned = desc.baud !== undefined
    ? DEFAULT_CONFIG.profiles[`${desc.kind}-${desc.baud}`]
    : undefined;
  return tuned ?? DEFAULT_CONFIG.profiles[byKind[desc.kind]] ?? DEFAULT_CONFIG.profiles.off;
}
```

- [ ] **Step 4: Run tests** — `cd emulator/relay && npm test`. Expected: PASS (all, not just new ones).

- [ ] **Step 5: Config + docs edits**
  - `pack.json`: `"baud": 300` → `"baud": 1200` (pstn only; norad stays 9600).
  - `emulator/relay/src/config.ts`: `"home-terminal": "dialup-300"` → `"home-terminal": "dialup-1200"`.
  - `emulator/README.md` line 13: `Era shaping (300 baud)` → `Era shaping (1200 baud)`.
  - `README.md` line 33: same change.
  - Run `grep -rn "300 baud" README.md emulator/README.md CONTRIBUTING.md PACK.md toolchain.md` and fix any remaining prose that states the pstn rate (leave historical/profile-name text in `config.ts` alone — `dialup-300` remains a valid profile).

- [ ] **Step 6: Verify live** — `make up` (background), `node emulator/cli/src/main.ts map --pack .` shows `pstn dialup, phone, 1200 baud`; dial the school and confirm the banner paints noticeably faster. Stop the federation.

- [ ] **Step 7: Commit**

```bash
git add emulator/relay/src/network.ts emulator/relay/src/config.ts emulator/relay/tests/network.test.ts pack.json README.md emulator/README.md
git commit -m "feat(relay): honor a network's declared baud; pstn at 1200"
```

---

### Task 2: Terminal auto-uppercase

**Files:**
- Modify: `emulator/terminal/src/protocol.ts:130-132` (`send`)
- Test: `emulator/terminal/tests/` (add to the existing protocol test file, or create `uppercase.test.ts` following the dir's conventions)

**Interfaces:**
- Consumes: `dial()` from `protocol.ts`.
- Produces: every outgoing line is uppercased on the wire. Both the CLI renderer and any xterm.js renderer inherit it. Programs still receive `INPUT <TEXT>` framing from the node host, unchanged.

- [ ] **Step 1: Write the failing test** (a minimal fake relay; adapt imports to match neighboring tests):

```ts
import { test } from "node:test";
import assert from "node:assert";
import { WebSocketServer } from "ws";
import { dial } from "../src/protocol.ts";

test("send() uppercases outgoing text like a caps-only terminal", async () => {
  const wss = new WebSocketServer({ port: 0 });
  const received: string[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (m) => received.push(m.toString()));
  });
  const port = (wss.address() as { port: number }).port;
  const line = await dial(`ws://127.0.0.1:${port}`, "(206) 555-0142");
  line.send("pencil");
  await new Promise((r) => setTimeout(r, 50));
  line.hangUp();
  await new Promise<void>((r) => wss.close(() => r()));
  assert.deepEqual(received, ["PENCIL"]);
});
```

- [ ] **Step 2: Run to verify it fails** — `cd emulator/terminal && npm test`. Expected: FAIL, received `["pencil"]`.

- [ ] **Step 3: Implement** — in `protocol.ts` `send`:

```ts
    send: (text: string) => {
      // A caps-only 1983 terminal: everything typed goes out uppercase.
      if (ws.readyState === WebSocket.OPEN) ws.send(text.toUpperCase());
    },
```

- [ ] **Step 4: Run tests** — `cd emulator/terminal && npm test`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add emulator/terminal/src/protocol.ts emulator/terminal/tests/
git commit -m "feat(terminal): uppercase outgoing input, caps-only-terminal style"
```

---

### Task 3: SYSTEM/1 `PROMPT` block — wire codec + protocol docs

**Files:**
- Modify: `emulator/node/app/systemwire.py` (`SystemResponse`, `parse_system_response`)
- Modify: `emulator/node/app/localcall.py` (~line 77, the aggregate `SystemResponse`)
- Modify: `PACK.md` (Wire protocols section)
- Test: `emulator/node/tests/test_systemwire.py`

**Interfaces:**
- Consumes: existing `SystemResponse` dataclass, `parse_system_response(raw, system_id)`.
- Produces: `SystemResponse` gains `prompt: str | None = None`. Response grammar: optional `PROMPT <text>` line between the `DISPLAY` block (or `CALL` block position) and `LINE`. Constraints enforced by the parser: nonempty text; not with `CALL`; not with `LINE DROP`. Tasks 4-9 rely on the field name `resp.prompt`.

- [ ] **Step 1: Write the failing tests** (append to `test_systemwire.py`, matching its existing fixtures/helpers for building raw responses):

```python
def test_parse_optional_prompt():
    raw = ("SYSTEM/1 school OK\nSTATE 1\nAUTH 1\nDISPLAY 1\nWELCOME\n"
           "PROMPT SELECT:\nLINE UP\nEND\n")
    resp = parse_system_response(raw, "school")
    assert resp.prompt == "SELECT:"
    assert resp.display == "WELCOME"

def test_prompt_absent_is_none():
    raw = "SYSTEM/1 school OK\nSTATE 0\nDISPLAY 1\nBYE\nLINE DROP\nEND\n"
    assert parse_system_response(raw, "school").prompt is None

def test_prompt_with_line_drop_rejected():
    raw = ("SYSTEM/1 school OK\nSTATE 0\nDISPLAY 1\nBYE\n"
           "PROMPT SELECT:\nLINE DROP\nEND\n")
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "school")

def test_prompt_with_call_rejected():
    raw = ("SYSTEM/1 school OK\nSTATE 0\nDISPLAY 1\nSEARCHING...\n"
           "CALL school-db 1\nRECORD 12\nPROMPT SELECT:\nLINE UP\nEND\n")
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "school")

def test_empty_prompt_rejected():
    raw = "SYSTEM/1 school OK\nSTATE 0\nDISPLAY 0\n\nPROMPT \nLINE UP\nEND\n"
    with pytest.raises(SystemWireError):
        parse_system_response(raw, "school")
```

(The empty-prompt raw above has a stray blank display line because `DISPLAY 0` is followed directly by `PROMPT ` — build it as `"SYSTEM/1 school OK\nSTATE 0\nDISPLAY 0\nPROMPT \nLINE UP\nEND\n"`.)

- [ ] **Step 2: Run to verify failure** — `cd emulator/node && python3 -m pytest tests/test_systemwire.py -x -q`. Expected: FAIL (`unexpected keyword`/attribute or parse error).

- [ ] **Step 3: Implement** — in `systemwire.py`:

Add to the dataclass:

```python
@dataclass(frozen=True)
class SystemResponse:
    system_id: str
    state: str      # opaque STATE block, newline-joined (no trailing newline)
    display: str    # human-facing teletype text
    line: str       # UP | DROP
    call: Call | None = None
    prompt: str | None = None   # what the system is asking, for the input line
```

In `parse_system_response`, after the CALL peek block and before the LINE parse:

```python
    # Optional PROMPT: what the system is asking, delivered on the input line
    # rather than in the transcript. A continuation (CALL) is not ready for
    # input, and a dropped line asks nothing — both are rejected.
    prompt: str | None = None
    if peeked.startswith("PROMPT "):
        if call is not None:
            raise SystemWireError("PROMPT may not accompany CALL")
        prompt = peeked[len("PROMPT "):]
        if not prompt.strip():
            raise SystemWireError("empty PROMPT")
        peeked = take()
```

After the LINE parse, beside the CALL/LINE check:

```python
    if prompt is not None and line != "UP":
        raise SystemWireError("PROMPT requires LINE UP")
```

Return `prompt=prompt` in the `SystemResponse`.

- [ ] **Step 4: Thread it through `localcall.py`** — read the file; where the aggregate `SystemResponse` is built (~line 77, `display="\n".join(displays)`), carry the **final** response's prompt: `prompt=resp.prompt` (the last resp in the chain). The intermediate displays are already joined; intermediate prompts cannot exist (parser rejects PROMPT+CALL).

- [ ] **Step 5: Run the node suite** — `cd emulator/node && python3 -m pytest tests/ -x -q`. Expected: PASS (existing tests unaffected — the field defaults to `None`).

- [ ] **Step 6: Document in PACK.md** — in the "Wire protocols" section, after the CALL/REPLY block, add:

```markdown
### Asking the user for something

A SYSTEM/1 response may end with one optional `PROMPT` line, between the
`DISPLAY` block and `LINE`:

```
PROMPT <text>            <- optional: what the system is asking
LINE UP
```

The harness delivers it out-of-band to the terminal's input line (the way game
monitors already deliver `[TTT]>`), so the cursor rests after the question the
way a real remote host left it. At most one per response; it may not accompany
`LINE DROP` (a dropped line asks nothing) or a `CALL` continuation (a program
mid-continuation is not ready for input). A response without `PROMPT` renders
exactly as before, so old-style programs are untouched.
```

- [ ] **Step 7: Commit**

```bash
git add emulator/node/app/systemwire.py emulator/node/app/localcall.py emulator/node/tests/test_systemwire.py PACK.md
git commit -m "feat(node): optional SYSTEM/1 PROMPT block in the wire codec"
```

---

### Task 4: `PROMPT` transport — NODE/1 frame, relay, node host, web bridge, renderer

**Files:**
- Modify: `emulator/relay/src/node-proto.ts` (`NodeFrame`, `FRAME_TYPES`, `decodeNodeFrame` validation)
- Modify: `emulator/relay/src/network.ts:141-154` (node-message handler)
- Modify: `emulator/node/app/nodehost.py:220-246` (`_turn`, after display delivery)
- Modify: `emulator/node/app/main.py:358-363` and `:432-437` (system CONNECT + INPUT paths)
- Modify: `emulator/terminal/src/render-tty.ts:26-34` (`onPrompt` dedupe)
- Test: `emulator/relay/tests/node-proto.test.ts`, `emulator/relay/tests/network.test.ts`, `emulator/node/tests/test_nodehost.py`, `emulator/terminal/tests/`

**Interfaces:**
- Consumes: `SystemResponse.prompt` (Task 3); envelope kind `"prompt"` (already in `envelope.ts` and handled by `protocol.ts`/`render-tty.ts`); `LinkShaper.send({kind, payload})`.
- Produces: NODE/1 frame `{ t: "PROMPT"; call: number; data: string }` (node → relay); relay forwards as a shaped `prompt` envelope; renderer prints the prompt on the input line on **every** arrival.

- [ ] **Step 1: node-proto failing test** (append to `node-proto.test.ts`):

```ts
test("PROMPT frames round-trip", () => {
  const f = decodeNodeFrame(JSON.stringify({ t: "PROMPT", call: 3, data: "TEST:" }));
  assert.deepEqual(f, { t: "PROMPT", call: 3, data: "TEST:" });
});

test("PROMPT frames require a call id", () => {
  assert.throws(() => decodeNodeFrame(JSON.stringify({ t: "PROMPT", data: "TEST:" })));
});
```

Run `cd emulator/relay && npm test` — expected FAIL (unknown frame type).

- [ ] **Step 2: Implement node-proto** — add to the `NodeFrame` union under "node -> relay": `| { t: "PROMPT"; call: number; data: string }`; add `"PROMPT"` to `FRAME_TYPES`; in `decodeNodeFrame`'s validation switch, validate like `FRAME` (requireCall + `data` must be a string; mirror the exact style used for `FRAME`). Run tests — PASS.

- [ ] **Step 3: relay forwarding failing test** — in `network.test.ts`, mirror the existing node→caller FRAME test (the file has one asserting a caller receives `output` envelopes): register a node, dial it, have the node send `{t: "PROMPT", call, data: "TEST:"}`, assert the caller receives an envelope with `kind: "prompt"` and reassembled payload `"TEST:"`. Copy the file's existing helpers for socket setup and envelope collection; the only novelty is the frame type and expected kind. Run — FAIL.

- [ ] **Step 4: Implement relay forwarding** — in `network.ts`, after the `f.t === "FRAME"` block:

```ts
      if (f.t === "PROMPT") {
        const call = calls.get(f.call);
        if (!call || call.node !== nodeId) return;
        // Not transcript text: rides the same shaped link, tagged for the
        // input line (envelope kind "prompt", reassembled by the client).
        call.shaper.send({ kind: "prompt", payload: f.data });
        return;
      }
```

Run `npm test` — PASS.

- [ ] **Step 5: node host failing test** — in `test_nodehost.py`, find the existing test that drives a `_turn` and asserts on the frames the fake connection received (the file has fakes for `conn`). Add: a runner whose response carries `prompt="TEST:"` results in the conn receiving, after the FRAME for the display, a `{"t": "PROMPT", "call": <id>, "data": "TEST:"}` message. Run — FAIL.

- [ ] **Step 6: Implement node host** — in `nodehost.py` `_turn`, after the `if resp.display:` delivery and before the `LINE DROP` check:

```python
            if resp.prompt:
                await conn.send(json.dumps(
                    {"t": "PROMPT", "call": call, "data": resp.prompt}))
```

Run `python3 -m pytest tests/test_nodehost.py -x -q` — PASS.

- [ ] **Step 7: web bridge** — in `main.py`, add after **both** display-send sites in the system path (after line ~359 in the CONNECT block and after line ~433 in the INPUT block):

```python
            if resp.prompt:
                await ws.send_text(envelope("prompt", resp.prompt))
```

(Indentation matches each site.) Verify the web terminal already renders `prompt` envelopes: `grep -rn '"prompt"' emulator/web --include='*.ts' --include='*.tsx' | grep -v node_modules` — the router path (`main.py:460`) has always sent them, so a handler must exist; if a system-session code path in the web terminal filters kinds, extend it the same way. Run the full node suite: `python3 -m pytest tests/ -x -q`.

- [ ] **Step 8: renderer re-display** — in `render-tty.ts`, systems re-send the same prompt every turn and each one must repaint (the dedupe was for mode-change prompts). Replace the `onPrompt` handler:

```ts
  const line = await dial(relay, address, {
    ...opts,
    // Repaint on every arrival: a system asks TEST: after each command, and
    // the question belongs on the input line each time, not only the first.
    onPrompt: (next) => { out.write(`\n${next} `); },
  });
```

(Delete the `shown` variable.) Add a terminal test mirroring the uppercase test's fake-relay setup: server sends two identical `prompt` envelopes (`{"v":1,"session":"s","seq":0,"kind":"prompt","link":"pstn","payload":"TEST:","eom":true}`), assert the captured output contains `"TEST: "` twice. Run `cd emulator/terminal && npm test` — PASS.

- [ ] **Step 9: Commit**

```bash
git add emulator/relay/src/node-proto.ts emulator/relay/src/network.ts emulator/relay/tests/ emulator/node/app/nodehost.py emulator/node/app/main.py emulator/node/tests/test_nodehost.py emulator/terminal/src/render-tty.ts emulator/terminal/tests/
git commit -m "feat(harness): carry SYSTEM/1 PROMPT end-to-end to the input line"
```

---

### Task 5: school.bas — PROMPT migration + clearer menu

**Files:**
- Modify: `systems/school/school.bas`
- Regenerate: `systems/school/harness/tests/*.out`
- Check: `emulator/node/tests/` for assertions on the old frame shape

**Interfaces:**
- Consumes: PROMPT grammar from Task 3 (`PROMPT <text>` before `LINE UP`; never with `CALL` or `LINE DROP`).
- Produces: school responses whose asking-lines are PROMPT; menu is 6 display lines (4 numbered + LIST line + COURSES line); `SELECT:` always emitted by the menu subroutine as a PROMPT.

- [ ] **Step 1: Edit `school.bas`** — every change below keeps `DISPLAY <k>` equal to the number of display lines actually printed:

  1. **CONNECT (3030-3060):** `DISPLAY 3` → `DISPLAY 2`; delete `3060 PRINT "PASSWORD:"`; insert before `LINE UP`: `3065 PRINT "PROMPT PASSWORD:"`.
  2. **Wrong password reprompt (3530-3550):** `DISPLAY 2` → `DISPLAY 1`; replace `3550 PRINT "PASSWORD:"` with `3550 PRINT "PROMPT PASSWORD:"` — note it must come **after** the display block it now follows (it already does; only the count changes).
  3. **Lockout (3600 block):** unchanged — `LINE DROP` takes no prompt.
  4. **Menu subroutine (7700-7760):** replace lines 7745-7750 with:
     ```
     7745 PRINT "LIST - STUDENT ROSTER (LIST A* TO FILTER)"
     7747 PRINT "COURSES - COURSE CATALOG (COURSES MA* TO FILTER)"
     ```
     The menu is still 6 display lines, so **every `DISPLAY 7`/`DISPLAY N9+8` count that includes the menu is unchanged**. `SELECT:` moves out: it is no longer printed by 7700.
  5. **Every caller of GOSUB 7700** (lines 3488, 3946, 3955, 3978, 4290, 4470, 4572, 4736, 5050, 5450, 6328, 6374, 6466 — i.e. each `GOSUB 7700` followed by `PRINT "LINE UP"`): insert `PRINT "PROMPT SELECT:"` between the GOSUB and the `LINE UP`. Simplest correct form: append it inside subroutine 7700 as its last statement (`7755 PRINT "PROMPT SELECT:"`) since every caller is a menu-return response — verify with `grep -n "GOSUB 7700" systems/school/school.bas` that no caller emits anything after the GOSUB except `LINE UP`/`END`.
  6. **Records name ask (4140-4150):** `DISPLAY 1` → `DISPLAY 0`; replace `PRINT "STUDENT NAME:"` with `PRINT "PROMPT STUDENT NAME:"` (now positioned where the display line was — after `DISPLAY 0`, which is correct grammar).
  7. **Grade-entry name ask (4340-4350):** `DISPLAY 1` → `DISPLAY 0`; `PRINT "GRADE ENTRY - STUDENT NAME:"` → `PRINT "PROMPT GRADE ENTRY - STUDENT NAME:"`.
  8. **Course ask (4448-4450):** `DISPLAY 1` → `DISPLAY 0`; → `PRINT "PROMPT COURSE:"`.
  9. **New grade ask (4528-4530):** `DISPLAY 1` → `DISPLAY 0`; → `PRINT "PROMPT NEW GRADE:"`.
  10. **Pager MORE page (6404-6416):** `DISPLAY " + N9+2` → `N9+1`; delete `6416 PRINT "MORE - TYPE M"`; insert `6418 PRINT "PROMPT MORE - TYPE M"` before `LINE UP`.
  11. **SEARCHING.../RECORDING... (4248-4256, 4618-4626):** unchanged — CALL continuations take no prompt.
  12. **Log off (5290):** unchanged — `LINE DROP`.

- [ ] **Step 2: Rebuild + eyeball one frame**

```bash
systems/school/harness/build.sh
systems/school/harness/bin/school < systems/school/harness/tests/01-connect.in
```

Expected: `DISPLAY 2`, no `PASSWORD:` in the display block, `PROMPT PASSWORD:` before `LINE UP`.

- [ ] **Step 3: Regenerate fixtures + review**

```bash
cd systems/school/harness
for f in tests/*.in; do bin/school < "$f" > "${f%.in}.out"; done
git diff -- tests/
```

Review every hunk: only DISPLAY counts, moved prompt lines, and the two new menu lines may change. Any other diff is a bug — stop and fix.

- [ ] **Step 4: Full gates** — `tools/test.sh systems` and `cd emulator/node && python3 -m pytest tests/ -x -q`. The lockout/reprompt node test (see commit 688048a) may assert `PASSWORD:` arrives as display text — if it fails, update its expectation to the new shape (prompt frame, not display). `tools/behavior.sh` too.

- [ ] **Step 5: Commit**

```bash
git add systems/school/school.bas systems/school/harness/tests/ emulator/node/tests/
git commit -m "feat(systems): school speaks PROMPT; clearer LIST/COURSES menu"
```

---

### Task 6: pactel — PROMPT migration

**Files:**
- Modify: `systems/pactel/pactel.c` (`emit_ok` + all call sites)
- Regenerate: `systems/pactel/harness/tests/*.out`

**Interfaces:**
- Consumes: PROMPT grammar (Task 3).
- Produces: `emit_ok(state_line, lines, nlines, prompt, line_status)` — `prompt` is `"TEST:"` on every `UP` response, `NULL` on `DROP`. Task 7 builds on this signature.

- [ ] **Step 1: Change `emit_ok`**

```c
/* Emit a well-formed SYSTEM/1 OK response. STATE is always the single
   "LINE <state_line>" tag; DISPLAY is the k lines in "lines"; prompt, when
   non-NULL, is emitted as the PROMPT block (never on a dropped line); LINE
   is line_status ("UP" or "DROP"). */
static void emit_ok(const char *state_line, const char *lines[], int nlines,
    const char *prompt, const char *line_status)
{
    int i;
    printf("SYSTEM/1 pactel OK\n");
    printf("STATE 1\n");
    printf("LINE %s\n", state_line);
    printf("DISPLAY %d\n", nlines);
    for (i = 0; i < nlines; i++) {
        printf("%s\n", lines[i]);
    }
    if (prompt != NULL) {
        printf("PROMPT %s\n", prompt);
    }
    printf("LINE %s\n", line_status);
    printf("END\n");
}
```

- [ ] **Step 2: Update every call site** — remove the trailing `"TEST:"` entry from each `lines[]` array, decrement the array size and `nlines`, and pass `"TEST:"` as `prompt`. Sites and their new display lines:
  - CONNECT: 2 lines (`PACIFIC TELEPHONE`, `AUTOMATIC TEST BOARD - AUTHORIZED USE ONLY`), prompt `"TEST:"`.
  - ANAC: 2 lines; MILLIWATT: 2; QT: 1; LOOP: 1; RING: 1; LINE set: 2; `?INVALID LINE`: 1; VERIFY: 2; HELP: 3; `?TEST NOT RECOGNIZED`: 1 — all prompt `"TEST:"`.
  - BYE (`TEST BOARD CLEARED.`): prompt `NULL`, status `"DROP"`.
  - `emit_protocol_error`: leave as-is (it hand-prints; add no prompt — `LINE DROP`).

- [ ] **Step 3: Rebuild + regenerate + review**

```bash
systems/pactel/harness/build.sh
cd systems/pactel/harness
for f in tests/*.in; do bin/pactel < "$f" > "${f%.in}.out"; done
git diff -- tests/
```

Every hunk must be: a `TEST:` line moving from the display block to `PROMPT TEST:`, and DISPLAY counts down by one. `tools/test.sh systems` green.

- [ ] **Step 4: Commit**

```bash
git add systems/pactel/pactel.c systems/pactel/harness/tests/
git commit -m "feat(systems): pactel speaks PROMPT"
```

---

### Task 7: pactel — billing desk (BAL / HIST / ADJ), persistent

**Files:**
- Create: `systems/pactel/data/accounts.dat`, `systems/pactel/data/calls.dat`
- Modify: `systems/pactel/pactel.c`, `systems/pactel/harness/manifest.json`, `systems/pactel/harness/build.sh` (wrapper, if not already chdir-ing)
- Create: fixtures `tests/07-bal.in/.out` … (numbering continues from the dir's last pair)

**Interfaces:**
- Consumes: `emit_ok(..., prompt, ...)` from Task 6; host persistent store (`"state": "persistent"`, the school-db mechanism — the host saves/loads the whole STATE block between calls).
- Produces: STATE grammar grows: line 1 `LINE <10 digits>`, then zero or more `ADJ <10 digits> <amount>` (amount like `0.00`). CONNECT preserves ADJ lines, resets the line under test to the default. New commands `BAL`, `HIST`, `ADJ <amount>`.

- [ ] **Step 1: Commit the data files** (fixed-width, one record per line; layouts documented in the C header comment):

`systems/pactel/data/accounts.dat` — line(10) 1sp name(22, space-padded) balance(8, right-justified):

```
2065550137 LIGHTMAN H                42.60
2065550199 MACK W                    12.05
2125550177 PAN AM FREIGHT DESK      310.40
3115550100 PACTEL TEST DESK           0.00
4085550163 PROTOVISION INC          128.75
2065554721 STERLING R                 7.20
```

`systems/pactel/data/calls.dat` — line(10) 1sp date(8) 1sp called(10) 1sp minutes(3, right-justified) 1sp charge(6, right-justified):

```
2065550137 04/12/83 2065550142   4   0.00
2065550137 04/14/83 3115550100   2   0.30
2065550137 04/15/83 4085550163  11   1.65
2065550137 04/18/83 2135550188   9   2.70
2065554721 04/02/83 2065550137   3   0.00
```

- [ ] **Step 2: Wrapper check** — data files are read at spawn relative to the program folder, so `bin/pactel` must be a wrapper that chdirs there first (PACK.md rule). Read `systems/airline/harness/build.sh` (airline already ships `data/`) and mirror its wrapper pattern exactly: build the real binary to a sibling name, emit `bin/pactel` as the chdir-then-exec script.

- [ ] **Step 3: Extend `pactel.c`.** Design (all C89, no wall clock):
  - Balances held as **cents in `long`** (parse `42.60` → 4260); print with `printf("$%ld.%02ld", cents / 100, cents % 100)`.
  - At spawn, load `data/accounts.dat` into parallel arrays (`acct_line[10+1]`, `acct_name[23]`, `acct_cents`) and `data/calls.dat` likewise (cap: 32 accounts, 64 calls; more is a quiet truncation — fine, files are ours). `fopen` failure → treat as zero records (the board still works as a test board).
  - STATE parsing loop (existing `LINE ` branch): add an `ADJ ` branch — `ADJ <10 digits> <amount>`; valid entries overwrite the in-memory balance for that account (append if the account is unknown — cap 32 overrides, `MAX_STATE_LINES` bumped from 20 to 48).
  - STATE emission: `emit_ok` must now emit `STATE 1+n_adj` — change its `state_line` parameter usage: keep printing `LINE <state_line>` first, then every tracked `ADJ <line10> <d.dd>` override. Make the override table file-scope so `emit_ok` can see it.
  - **CONNECT**: preserve parsed ADJ lines (they arrived in STATE from the persistent store), reset line under test to `DEFAULT_LINE`.
  - **BAL**: look up the line under test in accounts (after overrides): 3 display lines `BILLING INQUIRY`, `LINE AAA PPP NNNN` (via `format_line`), `SUBSCRIBER: <name>  BALANCE DUE $<d.dd>`; unknown line → 1 line `NO ACCOUNT ON FILE`. Prompt `"TEST:"`.
  - **HIST**: header `CALL HISTORY - AAA PPP NNNN`, then one line per matching call in file order: `MM/DD/YY AAA PPP NNNN  <MIN> MIN  $<d.dd>`; none → `NO CALLS ON FILE` after the header. Prompt `"TEST:"`.
  - **ADJ <amount>**: amount must be 1-6 digits, optionally followed by `.` and exactly 2 digits (`0`, `12.50`, `0.00`). Valid → record/overwrite the override for the current line, reply 2 lines `BALANCE ADJUSTED`, `LINE AAA PPP NNNN  BALANCE DUE $<d.dd>`; invalid → `?INVALID AMOUNT`. Unknown line under test → `NO ACCOUNT ON FILE` (no override recorded). Prompt `"TEST:"`.
  - **HELP**: add one display line before the prompt: `BILLING: BAL  HIST  ADJ <AMT>`.
  - Header comment: extend the wire-contract note with the new STATE grammar and a **room-to-grow** note: "Billing state is kept as ADJ tags so it could move wholesale into a pactel-db bus store (school/school-db pattern) if billing outgrows the test board."

- [ ] **Step 4: Manifest** — add to the `node` block of `systems/pactel/harness/manifest.json`:

```json
    "state": "persistent"
```

(Sibling of `networks`, exactly as `school-db`'s manifest has it.)

- [ ] **Step 5: New fixtures.** Continue the dir's numbering (check `ls systems/pactel/harness/tests`). Write each `.in` by hand; **generate** each `.out` with the built binary, then review. Cases:
  1. `NN-bal.in` — CONNECT-less INPUT `BAL` with `STATE 1` / `LINE 2065550137` → LIGHTMAN H, $42.60.
  2. `NN-bal-unknown.in` — `LINE 9995550000` in STATE, INPUT `BAL` → `NO ACCOUNT ON FILE`.
  3. `NN-hist.in` — INPUT `HIST` on 2065550137 → 4 call rows.
  4. `NN-adj.in` — INPUT `ADJ 0.00` on 2065550137 → `BALANCE ADJUSTED`, `$0.00`, and STATE now carries `ADJ 2065550137 0.00`.
  5. `NN-adj-carry.in` — STATE 2 (`LINE 2065550137` + `ADJ 2065550137 0.00`), INPUT `BAL` → `$0.00` (the override wins; this is the persistence round-trip).
  6. `NN-adj-invalid.in` — INPUT `ADJ POTATO` → `?INVALID AMOUNT`, no override in STATE.
  7. `NN-connect-carry.in` — CONNECT with STATE 2 carrying an ADJ → response STATE still carries the ADJ, line reset to default.

```bash
systems/pactel/harness/build.sh
cd systems/pactel/harness
for f in tests/*.in; do bin/pactel < "$f" > "${f%.in}.out"; done
git diff -- tests/   # old fixtures must be byte-identical except STATE grew? No —
```

**Old fixtures must not change at all** (no ADJ overrides in them → STATE stays 1 line). If they diff, the STATE emission is wrong — fix before continuing. `tools/test.sh systems` green.

- [ ] **Step 6: Live persistence check** — `make up` (background); dial `(311) 555-0100`; `BAL` → $42.60; `ADJ 0.00`; hang up (BYE); dial again; `BAL` → $0.00. Stop the federation. (This exercises the host store; fixtures can't.)

- [ ] **Step 7: Commit**

```bash
git add systems/pactel/
git commit -m "feat(systems): pactel billing desk - BAL, HIST, ADJ; persistent state"
```

---

### Task 8: protovision — PROMPT + greeting + `I <n>` info + `A` about

**Files:**
- Modify: `systems/protovision/protovision.s`
- Regenerate + create: `systems/protovision/harness/tests/`

**Interfaces:**
- Consumes: PROMPT grammar (Task 3); existing asm helpers `matchstr`, `emitz`, the title tables (`titlelo/titlehi`, `blurblo/blurbhi`).
- Produces: commands `L` (unchanged), `I <n>` (n = 1..5), `A`; every `LINE UP` response ends with `PROMPT COMMAND:`; `COMMAND:` no longer appears in display blocks.

- [ ] **Step 1: Read the dispatch** — read `protovision.s` in full (852 lines) before editing; identify the INPUT dispatch (where `L` and the queue commands are matched) and each response emitter's DISPLAY-count handling.

- [ ] **Step 2: PROMPT migration** — add RODATA `S_PROMPT: .byte "PROMPT COMMAND:", $0A, 0`; in every `LINE UP` response emitter, remove the `S_COMMAND` display line (decrement that response's DISPLAY count) and emit `S_PROMPT` immediately before `S_LINEUP`. `GOODBYE.`/`LINE DROP` paths get no prompt. Rebuild (`systems/protovision/harness/build.sh`), regenerate existing fixtures, review: every hunk is a moved `COMMAND:` and a count decrement.

- [ ] **Step 3: Greeting** — `S_G2` becomes: `.byte "DEV ACCESS ONLY - L LIST / I <N> INFO / A ABOUT", $0A, 0`.

- [ ] **Step 4: `I <n>` command.** Dispatch: first char `I`, second char space, third char `1`-`5`, then end of input → index n. Anything else after `I` → the existing `S_NOTITLE` (`NO SUCH TITLE`) response. Info pages as single RODATA blocks with embedded `$0A` (one `emitz` each), indexed by two new tables `infolo/infohi`:

```asm
I1: .byte "ZYPHON - SIDE-SCROLLING SPACE SHOOTER", $0A
    .byte "1 PLAYER. JOYSTICK. 48K.", $0A
    .byte "STATUS: RELEASED", $0A
    .byte "REV C - WAVE 9 BOSS REWORK", 0
I2: .byte "COMET JOCKEY - DODGE THE BELT", $0A
    .byte "1 PLAYER. HI-SCORE SAVE TO TAPE.", $0A
    .byte "STATUS: RELEASED", $0A
    .byte "REV B - SPLIT-SCREEN BONUS ROUND", 0
I3: .byte "IRON WEDGE - TOP-DOWN TANK COMBAT", $0A
    .byte "2 PLAYER SIMULTANEOUS.", $0A
    .byte "STATUS: RELEASED", $0A
    .byte "REV A - TOURNAMENT TABLE SHIPPED", 0
I4: .byte "VELDRAX - PRE-RELEASE (LOCKED)", $0A
    .byte "SLATED Q4 1983.", $0A
    .byte "DEV ACCESS ONLY - RELEASE PENDING", 0
I5: .byte "OBLICON - PRE-RELEASE (LOCKED)", $0A
    .byte "UNANNOUNCED.", $0A
    .byte "DEV ACCESS ONLY - RELEASE PENDING", 0
```

DISPLAY counts: 4 for I1-I3, 3 for I4-I5 (store a per-title count byte table `infoct: .byte 4, 4, 4, 3, 3`).

- [ ] **Step 5: `A` command** (input exactly `A`):

```asm
SA: .byte "PROTOVISION INC", $0A
    .byte "1200 ORCHARD PKWY - SUNNYVALE CA 94086", $0A
    .byte "DIAL-IN (408) 555-0163", $0A
    .byte "DISTRIBUTION - WESTERN MICRO SALES CO", $0A
    .byte "NOW HIRING 6502 PROGRAMMERS", 0
```

DISPLAY 5, then `PROMPT COMMAND:`, `LINE UP`.

- [ ] **Step 6: Fixtures** — regenerate existing; add pairs (continue numbering): `info-released` (`I 1`), `info-prerelease` (`I 4`), `info-bad` (`I 9` → `NO SUCH TITLE`), `about` (`A`). Hand-write `.in`s in the dir's existing frame style, generate `.out`s, review. `tools/test.sh systems` green.

- [ ] **Step 7: Commit**

```bash
git add systems/protovision/
git commit -m "feat(systems): protovision info pages, company screen, PROMPT"
```

---

### Task 9: airline + reference — PROMPT

**Files:**
- Modify: `systems/airline/airline.cob`, `systems/reference/reference.cob`
- Regenerate: both `harness/tests/` dirs

**Interfaces:**
- Consumes: PROMPT grammar (Task 3).
- Produces: every airline `LINE UP` response carries `PROMPT READY:`; every reference `LINE UP` response carries `PROMPT >`. `LINE DROP` responses unchanged. No display lines are removed in these two — their last lines are status text, not prompts.

- [ ] **Step 1: airline** — `grep -n 'DISPLAY "LINE UP"' systems/airline/airline.cob` and insert `DISPLAY "PROMPT READY:"` immediately before each (respecting COBOL area/period syntax of the surrounding paragraph — watch for the `.` sentence terminators; the safest edit keeps each `DISPLAY` its own sentence). `LINE DROP` sites untouched. Rebuild, regenerate, review the diff (every hunk = one added `PROMPT READY:` line).

- [ ] **Step 2: reference** — same treatment with `DISPLAY "PROMPT >"`. Rebuild, regenerate, review.

- [ ] **Step 3: Gates** — `tools/test.sh systems`; `cd emulator/node && python3 -m pytest tests/ -x -q` (peer-call tests that stub system responses may need the new frame shape only if they assert byte-exact responses — fix as found).

- [ ] **Step 4: Commit**

```bash
git add systems/airline/ systems/reference/
git commit -m "feat(systems): airline and reference speak PROMPT"
```

---

### Task 10: Integration gate + PR

**Files:** none new — verification and PR.

- [ ] **Step 1: Full local gates**

```bash
make test                 # every golden fixture, all categories
tools/behavior.sh         # tictactoe self-play + GTW convergence
cd emulator/node && python3 -m pytest tests/ -q && cd ../..
cd emulator/relay && npm test && cd ../..
cd emulator/terminal && npm test && cd ../..
cd emulator/cli && npm test && cd ../..
```

All green before proceeding.

- [ ] **Step 2: Live dial-through** — `make up` (background), then in tmux dial and verify with a lowercase-typed session:
  - School `(206) 555-0142`: banner at visibly 1200-baud pace; cursor rests after `PASSWORD: `; typing `pencil` (lowercase) authenticates; menu shows the two new LIST/COURSES lines; `list` pages the roster with the cursor after `MORE - TYPE M `; a record lookup still round-trips school-db.
  - PacTel `(311) 555-0100`: cursor after `TEST: `; `bal`, `hist`, `adj 0.00` work lowercase; redial shows the adjusted balance.
  - Protovision `(408) 555-0163`: `l`, `i 1`, `i 4`, `a` all render; cursor after `COMMAND: `.
  - Airline `(212) 555-0177` and reference `(311) 555-0101`: cursor after `READY: ` / `> `.
  - Stop the federation.

- [ ] **Step 3: Push + PR**

```bash
git push -u origin claude/pack-improvements
gh pr create --title "Six pack improvements: 1200 baud, SYSTEM/1 PROMPT, uppercase input, school menu, protovision + pactel content" --body "..."
```

PR body: summarize the six changes, link the spec, note the fixture regenerations were diff-reviewed, and flag the cross-repo follow-ups: engine repo (`real-wopr`) needs `docs/systems.md` updated for `PROMPT`, `packs.lock` re-pinned, evals re-run; `real-wopr-site` needs the home-terminal static export regenerated (baud + prompt rendering). End with the standard generated-with footer.

- [ ] **Step 4: CI** — watch the 9 jobs (`gh pr checks --watch`); fix and push until green. Merge with a merge commit only after green and user sign-off.
