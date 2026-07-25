import test from "node:test";
import assert from "node:assert/strict";
import {
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  fitScale,
  monitors,
  monitorSrc,
  wallParamsFromSearch,
} from "./wall.ts";

test("monitors: defaults are same-origin exported routes incl. tracks", () => {
  const m = monitors();
  assert.deepEqual(m.map((x) => x.id), ["bigboard", "panel", "norad", "tracks"]);
  assert.equal(m[0].base, "/bigboard/");
  assert.equal(m[1].base, "/panel/");
  assert.equal(m[2].base, "/norad/");
  assert.equal(m[3].base, "/bigboard/tracks/");
  assert.equal(m[0].title, "BIG BOARD");
  assert.equal(m[3].title, "TACTICAL TRACKS");
});

test("monitors: env overrides replace bases per monitor", () => {
  const m = monitors({ bigboard: "http://localhost:3002/bigboard/",
                       tracks: "http://localhost:3002/bigboard/tracks/" });
  assert.equal(m[0].base, "http://localhost:3002/bigboard/");
  assert.equal(m[1].base, "/panel/");
  assert.equal(m[3].base, "http://localhost:3002/bigboard/tracks/");
});

test("wallParamsFromSearch: valid room is uppercased and accepted", () => {
  assert.deepEqual(wallParamsFromSearch("?room=abcdef"), { room: "ABCDEF" });
});

test("wallParamsFromSearch: malformed room reported, not forwarded", () => {
  const p = wallParamsFromSearch("?room=IO");
  assert.equal(p.room, undefined);
  assert.equal(p.malformedRoom, "IO");
});

test("wallParamsFromSearch: api/link accept https/wss only (no downgrade)", () => {
  const ok = wallParamsFromSearch("?api=https://x.example&link=wss://x.example/link");
  assert.equal(ok.api, "https://x.example");
  assert.equal(ok.link, "wss://x.example/link");
  const bad = wallParamsFromSearch("?api=http://x.example&link=ws://x.example");
  assert.equal(bad.api, undefined);
  assert.equal(bad.link, undefined);
});

test("wallParamsFromSearch: empty search is empty params", () => {
  assert.deepEqual(wallParamsFromSearch(""), {});
});

test("monitorSrc: appends room/api/link, preserving existing query", () => {
  assert.equal(monitorSrc("/bigboard/", { room: "ABCDEF" }), "/bigboard/?room=ABCDEF");
  assert.equal(
    monitorSrc("/norad/", { room: "ABCDEF", api: "https://x.example", link: "wss://x.example/link" }),
    "/norad/?room=ABCDEF&api=https%3A%2F%2Fx.example&link=wss%3A%2F%2Fx.example%2Flink",
  );
  assert.equal(monitorSrc("/panel/?theme=amber", { room: "ABCDEF" }), "/panel/?theme=amber&room=ABCDEF");
  assert.equal(monitorSrc("/panel/", {}), "/panel/");
});

test("fitScale: contains the design frame in the tile", () => {
  assert.equal(fitScale(DESIGN_WIDTH, DESIGN_HEIGHT), 1);
  assert.equal(fitScale(DESIGN_WIDTH / 2, DESIGN_HEIGHT), 0.5);
  assert.equal(fitScale(DESIGN_WIDTH, DESIGN_HEIGHT / 4), 0.25);
  assert.equal(fitScale(0, DESIGN_HEIGHT), 0);
  assert.equal(fitScale(DESIGN_WIDTH, -1), 0);
});
