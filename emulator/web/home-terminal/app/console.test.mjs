import test from "node:test";
import assert from "node:assert/strict";
import { parse, directoryText, sessionBody, DEFAULT_WOPR_NUMBER } from "./console.ts";
import { DIAL_SYSTEMS } from "./sims.ts";
import { buildSweep } from "./wardial.ts";

// A representative phone book: one community exchange, then the four local
// SYSTEM/1 numbers, then the default WOPR line (appended by the parser).
const EXCHANGE = {
  id: "ex-cheyenne",
  name: "CHEYENNE MOUNTAIN",
  region: "SAO PAULO BR",
  api: "https://ex.example",
  link: "wss://ex.example/link",
  joshua: "period",
};

const ctx = { exchanges: [EXCHANGE], systems: DIAL_SYSTEMS, hits: null };
const soloCtx = { exchanges: null, systems: DIAL_SYSTEMS, hits: null };

test("HELP prints the command list", () => {
  const a = parse("HELP", ctx);
  assert.equal(a.kind, "help");
  assert.match(a.text, /COMMANDS/);
  assert.match(a.text, /ATDT/);
  // '?' is an alias for HELP
  assert.equal(parse("?", ctx).kind, "help");
});

test("HELP is case-insensitive and trimmed", () => {
  assert.equal(parse("  help  ", ctx).kind, "help");
});

test("DIRECTORY lists exchanges and local systems as text", () => {
  const a = parse("directory", ctx);
  assert.equal(a.kind, "directory");
  assert.match(a.text, /CHEYENNE MOUNTAIN/);
  assert.match(a.text, /PAN AM \/ PANAMAC/);
  assert.match(a.text, /GOOSE LAKE SCHOOL DISTRICT/);
  // the mystery carrier is present but unlabeled (the directory must not
  // reveal it is WOPR before you connect)
  assert.match(a.text, /UNKNOWN/);
  assert.equal(/\bWOPR\b/.test(a.text), false);
  // directoryText helper matches the DIRECTORY action text
  assert.equal(directoryText(ctx), a.text);
});

test("DIAL by index resolves the numbered directory entry", () => {
  // 01 = the exchange, 02 = the first local system (airline)
  const a1 = parse("DIAL 01", ctx);
  assert.equal(a1.kind, "dial");
  assert.equal(a1.target, EXCHANGE);
  const a2 = parse("DIAL 2", ctx);
  assert.equal(a2.kind, "dial");
  assert.equal(a2.target.systemId, "airline");
});

test("DIAL by index out of range errors", () => {
  const a = parse("DIAL 99", ctx);
  assert.equal(a.kind, "error");
});

test("DIAL by name prefix (case-insensitive) matches", () => {
  const a = parse("dial pan", ctx);
  assert.equal(a.kind, "dial");
  assert.equal(a.target.systemId, "airline");
  // an exchange name prefix works too
  assert.equal(parse("DIAL CHEYENNE", ctx).target, EXCHANGE);
  // the mystery carrier dials by its "UNKNOWN" label (target null); it is not
  // reachable by the name "WOPR" — the directory never reveals it
  assert.equal(parse("DIAL UNKNOWN", ctx).target, null);
  assert.equal(parse("DIAL WOPR", ctx).kind, "error");
});

test("DIAL by unknown name errors", () => {
  assert.equal(parse("DIAL NOWHERE", ctx).kind, "error");
});

test("ATDT with punctuation dials the matching system", () => {
  const a = parse("ATDT (212) 555-0177", ctx);
  assert.equal(a.kind, "dial");
  assert.equal(a.target.systemId, "airline");
});

test("ATDT with bare digits dials the same system", () => {
  const a = parse("ATDT 2125550177", ctx);
  assert.equal(a.kind, "dial");
  assert.equal(a.target.systemId, "airline");
});

test("ATDT the default WOPR number dials the default line", () => {
  const bare = DEFAULT_WOPR_NUMBER.replace(/\D/g, "");
  const a = parse(`ATDT ${bare}`, ctx);
  assert.equal(a.kind, "dial");
  assert.equal(a.target, null);
  // punctuated form too
  assert.equal(parse(`ATDT ${DEFAULT_WOPR_NUMBER}`, ctx).target, null);
});

test("ATDT an unknown number is a NO CARRIER error", () => {
  const a = parse("ATDT 5559999", ctx);
  assert.equal(a.kind, "error");
});

test("a bare 1-2 digit token dials the directory index like DIAL <nn>", () => {
  // 01 = the exchange, 2 = the first local system (airline) — same as DIAL <nn>
  const a1 = parse("01", ctx);
  assert.equal(a1.kind, "dial");
  assert.equal(a1.target, EXCHANGE);
  const a2 = parse("2", ctx);
  assert.equal(a2.kind, "dial");
  assert.equal(a2.target.systemId, "airline");
  // out of range still errors, exactly like DIAL <nn>
  assert.equal(parse("99", ctx).kind, "error");
});

test("a bare index honours the war-dial hit list when present", () => {
  const hits = buildSweep(DIAL_SYSTEMS).filter((e) => e.status === "CARRIER");
  const hitCtx = { ...soloCtx, hits };
  const a1 = parse("1", hitCtx);
  assert.equal(a1.kind, "dial");
  assert.equal(a1.target.systemId, "airline");
  // the last carrier is the unknown WOPR (target null)
  const last = parse(`${hits.length}`, hitCtx);
  assert.equal(last.kind, "dial");
  assert.equal(last.target, null);
});

test("a bare full number dials directly like ATDT, with or without punctuation", () => {
  // punctuated
  const a1 = parse("(212) 555-0177", ctx);
  assert.equal(a1.kind, "dial");
  assert.equal(a1.target.systemId, "airline");
  // bare digits
  const a2 = parse("2125550177", ctx);
  assert.equal(a2.kind, "dial");
  assert.equal(a2.target.systemId, "airline");
  // the default WOPR number reaches the default line (target null)
  const bare = DEFAULT_WOPR_NUMBER.replace(/\D/g, "");
  assert.equal(parse(bare, ctx).target, null);
});

test("a bare unknown long number is a NO CARRIER error like ATDT", () => {
  const a = parse("2125559999", ctx);
  assert.equal(a.kind, "error");
  assert.match(a.text, /NO CARRIER/);
});

test("a bare non-numeric token is still a HUH error", () => {
  const a = parse("FROB1", ctx);
  assert.equal(a.kind, "error");
  assert.match(a.text, /HELP/);
});

test("SCAN and WARDIAL and REDIAL are their own actions", () => {
  assert.equal(parse("scan", ctx).kind, "scan");
  assert.equal(parse("WARDIAL", ctx).kind, "wardial");
  assert.equal(parse("redial", ctx).kind, "redial");
});

test("VOICE ON / VOICE OFF toggle the voice", () => {
  assert.deepEqual(parse("voice on", ctx), { kind: "voice", on: true });
  assert.deepEqual(parse("VOICE OFF", ctx), { kind: "voice", on: false });
  // bare or malformed VOICE is an error with guidance
  assert.equal(parse("VOICE", ctx).kind, "error");
});

test("unknown command is a terse error pointing at HELP", () => {
  const a = parse("FROB", ctx);
  assert.equal(a.kind, "error");
  assert.match(a.text, /HELP/);
});

test("empty input is a no-op print", () => {
  const a = parse("   ", ctx);
  assert.equal(a.kind, "print");
  assert.equal(a.text, "");
});

test("DIAL <n> resolves against the war-dial hit list when present", () => {
  const hits = buildSweep(DIAL_SYSTEMS).filter((e) => e.status === "CARRIER");
  const hitCtx = { ...soloCtx, hits };
  // hit 1 is the first labeled carrier (airline)
  const a1 = parse("DIAL 1", hitCtx);
  assert.equal(a1.kind, "dial");
  assert.equal(a1.target.systemId, "airline");
  // the last carrier is the unknown WOPR (target null)
  const last = parse(`DIAL ${hits.length}`, hitCtx);
  assert.equal(last.kind, "dial");
  assert.equal(last.target, null);
  // out of range within the hit list errors
  assert.equal(parse(`DIAL ${hits.length + 1}`, hitCtx).kind, "error");
});

test("sessionBody omits room_code for a SYSTEM/1 dial (bridge rejects system+room)", () => {
  // Even with a live room in the URL, a system dial must not carry it.
  const body = sessionBody("home-terminal", "UXBB6B", "airline");
  assert.deepEqual(body, { surface: "home-terminal", system: "airline" });
  assert.equal("room_code" in body, false);
});

test("sessionBody carries the room for an exchange/WOPR dial (systemId null)", () => {
  const body = sessionBody("home-terminal", "UXBB6B", null);
  assert.deepEqual(body, { surface: "home-terminal", room_code: "UXBB6B" });
});

test("sessionBody omits room_code when there is no room", () => {
  assert.deepEqual(sessionBody("home-terminal", undefined, null), { surface: "home-terminal" });
  assert.deepEqual(sessionBody("home-terminal", undefined, "airline"), {
    surface: "home-terminal",
    system: "airline",
  });
});

test("sessionBody carries ?joshua= for an exchange dial", () => {
  assert.deepEqual(sessionBody("home-terminal", undefined, null, "claude"), {
    surface: "home-terminal",
    joshua: "claude",
  });
  assert.deepEqual(sessionBody("home-terminal", "UXBB6B", null, "lisp"), {
    surface: "home-terminal",
    room_code: "UXBB6B",
    joshua: "lisp",
  });
});

test("sessionBody omits joshua for a SYSTEM/1 dial — no Joshua is reachable there", () => {
  assert.deepEqual(sessionBody("home-terminal", undefined, "airline", "claude"), {
    surface: "home-terminal",
    system: "airline",
  });
});

test("sessionBody omits joshua when none was asked for", () => {
  for (const value of [undefined, ""]) {
    assert.equal("joshua" in sessionBody("home-terminal", undefined, null, value), false);
  }
});

test("sessionBody does not vet the processor name — the exchange owns that list", () => {
  assert.equal(sessionBody("home-terminal", undefined, null, "nonsense").joshua, "nonsense");
});

test("directoryText groups world-tagged exchanges under WORLD headings", () => {
  const exchanges = [
    { id: "a", name: "CHEYENNE EXCH", region: "SAO PAULO BR", api: "https://x", link: "wss://x", joshua: "period", world: 1, slot: "WOPR" },
    { id: "b", name: "ANNEX EXCH", region: "PORTLAND US", api: "https://y", link: "wss://y", joshua: "period", world: 2, slot: "SCHOOL" },
  ];
  const text = directoryText({ exchanges, systems: [], hits: null });
  const lines = text.split("\n");
  const w1 = lines.indexOf("-- WORLD 1 --"), w2 = lines.indexOf("-- WORLD 2 --");
  assert.ok(w1 >= 0 && w2 > w1);
  assert.ok(lines[w1 + 1].includes("CHEYENNE EXCH") && lines[w1 + 1].includes("WOPR"));
  assert.ok(lines[w2 + 1].includes("ANNEX EXCH"));
});

test("directoryText prints an untagged book with no WORLD headings", () => {
  // A phone-book entry that never came from a trunk has no world; the
  // directory must look exactly as it did before worlds existed.
  assert.equal(/-- WORLD/.test(directoryText(ctx)), false);
});

test("directoryText fits an 80-column terminal in the worst case", () => {
  // The IMSAI's screen is 80 columns; a wrapped directory line is a visible
  // defect. Worst case is every field at its maximum simultaneously: a 24-char
  // name and a 24-char region (the REGISTER wire caps both at 24), the longest
  // roster slot (PROTOVISION, 11), and the period-engine suffix.
  const exchanges = [{
    id: "a", name: "X".repeat(24), region: "Y".repeat(24),
    api: "https://x", link: "wss://x", joshua: "period", world: 1, slot: "PROTOVISION",
  }];
  const lines = directoryText({ exchanges, systems: [], hits: null }).split("\n");
  const entry = lines.find((l) => l.includes("PROTOVISION"));
  assert.ok(entry, "the worst-case entry must be printed");
  assert.ok(entry.length <= 80, `worst-case entry is ${entry.length} cols: ${JSON.stringify(entry)}`);
  for (const l of lines) assert.ok(l.length <= 80, `line over 80 cols: ${JSON.stringify(l)}`);
});
