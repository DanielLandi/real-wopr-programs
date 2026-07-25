import test from "node:test";
import assert from "node:assert/strict";
import { loadExchanges, valid } from "./exchanges.ts";

// A well-formed phone-book entry (matches db/migrations/0002_exchanges.sql,
// which CHECKs api ~ '^https://' and link ~ '^wss://').
const GOOD = {
  id: "trunk-abc234",
  name: "BASEMENT EXCH",
  region: "PORTLAND US",
  api: "https://hub.example/x/ABC234",
  link: "wss://hub.example/x/ABC234/link",
  joshua: "period",
};

test("valid keeps a well-formed https/wss entry", () => {
  assert.deepEqual(valid([GOOD]), [GOOD]);
});

test("valid rejects non-array and non-object input", () => {
  assert.deepEqual(valid(null), []);
  assert.deepEqual(valid("nope"), []);
  assert.deepEqual(valid([null, 7, "x"]), []);
});

test("valid rejects entries with non-string fields", () => {
  assert.deepEqual(valid([{ ...GOOD, api: 7 }]), []);
  assert.deepEqual(valid([{ ...GOOD, link: null }]), []);
  assert.deepEqual(valid([{ ...GOOD, name: 7 }]), []);
  assert.deepEqual(valid([{ ...GOOD, region: undefined }]), []);
});

test("valid rejects a downgraded http: api endpoint", () => {
  assert.deepEqual(valid([{ ...GOOD, api: "http://hub.example/x/ABC234" }]), []);
});

test("valid rejects a downgraded ws: link endpoint", () => {
  assert.deepEqual(valid([{ ...GOOD, link: "ws://hub.example/x/ABC234/link" }]), []);
});

test("valid rejects scheme look-alikes (https must be a real URL scheme prefix)", () => {
  // "wss:" must be the scheme, not merely a substring later in the URL.
  assert.deepEqual(valid([{ ...GOOD, link: "javascript:wss://x" }]), []);
  assert.deepEqual(valid([{ ...GOOD, api: "ftp://hub/https://x" }]), []);
});

test("valid filters hostile entries out of a mixed directory, keeping good ones", () => {
  const evil = { ...GOOD, id: "trunk-evil", link: "ws://attacker.example/link" };
  assert.deepEqual(valid([GOOD, evil]), [GOOD]);
});

// ---- loadExchanges: Supabase-mode load ------------------------------------

const TRUNK_GOOD = {
  id: "trunk-def567",
  name: "GARAGE EXCH",
  region: "SEATTLE US",
  api: "https://hub.example/x/DEF567",
  link: "wss://hub.example/x/DEF567/link",
  joshua: "claude",
};

const SUPABASE_CFG = {
  source: "supabase",
  url: "https://ref.supabase.co",
  anon_key: "anon",
  trunk_directory: "https://hub.example/trunk/directory",
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function jsonResponse(body, ok = true) {
  return { ok, json: async () => body };
}

/** Install a fetch mock keyed by URL substring. Each route is either a plain
 *  response or a deferred whose dispatch is recorded — lets a test observe
 *  request ordering. Restored via t.after. */
function mockFetch(t, routes) {
  const realFetch = globalThis.fetch;
  const dispatched = [];
  globalThis.fetch = (url) => {
    for (const [key, r] of routes) {
      if (String(url).includes(key)) {
        dispatched.push(key);
        return typeof r.then === "function" ? r : Promise.resolve(r);
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  return dispatched;
}

async function until(cond, what) {
  const deadline = Date.now() + 1000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((res) => setImmediate(res));
  }
}

test("supabase mode dispatches PostgREST and trunk fetches concurrently", async (t) => {
  const rest = deferred();
  const trunk = deferred();
  const dispatched = mockFetch(t, [
    ["phonebook.json", jsonResponse(SUPABASE_CFG)],
    ["/rest/v1/exchanges", rest.promise],
    ["/trunk/directory", trunk.promise],
  ]);

  const loading = loadExchanges();
  // Both requests must be in flight before either has resolved — a
  // sequential implementation would never dispatch the trunk fetch here.
  await until(
    () => dispatched.includes("/rest/v1/exchanges") && dispatched.includes("/trunk/directory"),
    "both fetches to dispatch",
  );

  rest.resolve(jsonResponse([GOOD]));
  trunk.resolve(jsonResponse({ exchanges: [TRUNK_GOOD] }));
  assert.deepEqual(await loading, [GOOD, TRUNK_GOOD]);
});

test("supabase mode degrades to book rows alone when the trunk directory fails", async (t) => {
  const trunkFail = Promise.reject(new Error("trunk down"));
  trunkFail.catch(() => {}); // pre-handled so the mock route itself never trips Node
  mockFetch(t, [
    ["phonebook.json", jsonResponse(SUPABASE_CFG)],
    ["/rest/v1/exchanges", jsonResponse([GOOD])],
    ["/trunk/directory", trunkFail],
  ]);
  assert.deepEqual(await loadExchanges(), [GOOD]);
});

test("supabase mode returns null when PostgREST fails, even if the trunk answers", async (t) => {
  mockFetch(t, [
    ["phonebook.json", jsonResponse(SUPABASE_CFG)],
    ["/rest/v1/exchanges", jsonResponse(null, false)],
    ["/trunk/directory", jsonResponse({ exchanges: [TRUNK_GOOD] })],
  ]);
  assert.equal(await loadExchanges(), null);
});

test("supabase mode dedupes trunk entries behind the book's own rows by id", async (t) => {
  const shadow = { ...TRUNK_GOOD, id: GOOD.id, name: "IMPOSTOR EXCH" };
  mockFetch(t, [
    ["phonebook.json", jsonResponse(SUPABASE_CFG)],
    ["/rest/v1/exchanges", jsonResponse([GOOD])],
    ["/trunk/directory", jsonResponse({ exchanges: [shadow, TRUNK_GOOD] })],
  ]);
  assert.deepEqual(await loadExchanges(), [GOOD, TRUNK_GOOD]);
});
