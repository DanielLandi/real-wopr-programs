import test from "node:test";
import assert from "node:assert/strict";
import { endpointFromQuery } from "../src/endpoint.ts";

/** Point the helper's window check at a fake location. Restored via t.after. */
function withSearch(t, search) {
  globalThis.window = { location: { search } };
  t.after(() => { delete globalThis.window; });
}

test("endpointFromQuery returns the fallback outside a browser", () => {
  assert.equal(endpointFromQuery("api", "https://build.example"), "https://build.example");
  assert.equal(endpointFromQuery("link", undefined), undefined);
});

test("endpointFromQuery returns the fallback when the param is absent", (t) => {
  withSearch(t, "?room=ABC234");
  assert.equal(endpointFromQuery("api", "https://build.example"), "https://build.example");
});

test("endpointFromQuery accepts https: api and wss: link overrides", (t) => {
  withSearch(t, "?api=https%3A%2F%2Fother.example&link=wss%3A%2F%2Fother.example%2Flink");
  assert.equal(endpointFromQuery("api", "https://build.example"), "https://other.example");
  assert.equal(endpointFromQuery("link", "wss://build.example/link"), "wss://other.example/link");
});

test("endpointFromQuery refuses downgraded or bogus schemes", (t) => {
  withSearch(t, "?api=http%3A%2F%2Fattacker.example&link=javascript%3Aalert(1)");
  assert.equal(endpointFromQuery("api", "https://build.example"), "https://build.example");
  assert.equal(endpointFromQuery("link", "wss://build.example/link"), "wss://build.example/link");
});
