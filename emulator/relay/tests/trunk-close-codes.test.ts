// The README's TRUNK/1 close-code table and the code that sends those codes
// must agree — a third-party peer reads the table, not `server.ts`. Grep the
// constants out of the source and compare them to the rows, both ways:
//
//   * every `host.close(NNNN, "reason")` in `trunkWss`'s connection handler
//     is a row with that exact code and reason text, and every row is such a
//     close;
//   * the codes the tie line treats as terminal (`stopped = true` on close)
//     are exactly the rows whose "Tie line" column says `terminal —`, and the
//     conditional one (`4400`, terminal only before ASSIGNED) says so.
//
// Nothing is rendered or dialled here; this is a drift check, not a behaviour
// test — `trunk-e2e`, `tieline` and `peer-not-a-hub` cover behaviour.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, here), "utf8");

/** The text of one `<name>.on("connection", …)` handler, up to the next one. */
function connectionHandler(src: string, wss: string): string {
  const start = src.indexOf(`${wss}.on("connection"`);
  assert.ok(start >= 0, `${wss}.on("connection") not found`);
  const head = `${wss}.on("connection"`;
  const rest = src.slice(start + head.length);
  const next = rest.search(/\w+Wss\.on\("connection"/);
  return head + (next < 0 ? rest : rest.slice(0, next));
}

/** `{ code -> reason }` for every `host.close(NNNN, "…")` in the trunk handler. */
function hubCloses(): Map<number, string> {
  const block = connectionHandler(read("../src/server.ts"), "trunkWss");
  const out = new Map<number, string>();
  for (const m of block.matchAll(/host\.close\((\d{4}),\s*"([^"]+)"\)/g)) {
    const code = Number(m[1]);
    assert.ok(!out.has(code) || out.get(code) === m[2],
      `server.ts closes ${code} with two different reasons`);
    out.set(code, m[2]);
  }
  assert.ok(out.size > 0, "no host.close(NNNN, …) found in the trunk handler");
  return out;
}

/** The tie line's terminal codes, and the ones terminal only before ASSIGNED. */
function tielineVerdicts(): { terminal: Set<number>; conditional: Set<number> } {
  const src = read("../src/tieline.ts");
  const start = src.indexOf('hub.on("close"');
  assert.ok(start >= 0, 'tieline.ts: hub.on("close") not found');
  const block = src.slice(start);
  const refused = block.indexOf("LINE REFUSED");
  const notAccepted = block.indexOf("LINE NOT ACCEPTED");
  assert.ok(refused > 0 && notAccepted > refused, "tieline.ts close handler shape changed");
  const codes = (s: string) => new Set([...s.matchAll(/closeCode === (\d{4})/g)].map((m) => Number(m[1])));
  const terminal = codes(block.slice(0, refused));
  const conditional = codes(block.slice(refused, notAccepted));
  assert.ok(terminal.size > 0 && conditional.size > 0);
  return { terminal, conditional };
}

type Row = { code: number; reason: string; verdict: "terminal" | "conditional" | "redial" };

/** The rows of the README's close-code table. */
function readmeRows(): Row[] {
  const readme = read("../README.md");
  const start = readme.indexOf("## Close codes");
  assert.ok(start >= 0, "README.md has no `## Close codes` section");
  const section = readme.slice(start);
  const rows: Row[] = [];
  for (const line of section.split("\n")) {
    const m = /^\| `(\d{4})` \| `([^`]+)` \|(?:[^|]*\|){1}([^|]*)\|/.exec(line);
    if (!m) continue;
    const tie = m[3].trim();
    const verdict = tie.startsWith("terminal before") ? "conditional"
      : tie.startsWith("terminal") ? "terminal" : "redial";
    rows.push({ code: Number(m[1]), reason: m[2], verdict });
  }
  assert.ok(rows.length > 0, "README `## Close codes` has no table rows");
  return rows;
}

test("every /trunk close the hub sends is a README row with the same reason, and vice versa", () => {
  const closes = hubCloses();
  const rows = readmeRows();
  const documented = new Map(rows.map((r) => [r.code, r.reason]));
  assert.deepEqual([...documented.keys()].sort(), [...closes.keys()].sort(),
    "README rows and server.ts trunk closes name different codes");
  for (const [code, reason] of closes) {
    assert.equal(documented.get(code), reason, `README reason for ${code} differs from server.ts`);
  }
});

test("the README's tie-line column matches what tieline.ts actually does with each code", () => {
  const { terminal, conditional } = tielineVerdicts();
  const rows = readmeRows();
  const by = (v: Row["verdict"]) => rows.filter((r) => r.verdict === v).map((r) => r.code).sort();
  assert.deepEqual(by("terminal"), [...terminal].sort(), "terminal set differs from tieline.ts");
  assert.deepEqual(by("conditional"), [...conditional].sort(), "conditional (before ASSIGNED) set differs");
  // Whatever is left must be a redial: no code is terminal in the tie line and undocumented.
  for (const code of [...terminal, ...conditional]) {
    assert.ok(rows.some((r) => r.code === code), `tieline.ts decides ${code} but the README has no row`);
  }
});
