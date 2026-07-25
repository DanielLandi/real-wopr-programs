// `wopr map` rendering, and the gate that stops `wopr up` on a broken topology.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMap } from "../src/map.ts";
import { errorsOf, warningsOf, type Topology } from "../src/topology.ts";

const TOPO: Topology = {
  networks: {
    pstn: { name: "pstn", kind: "dialup", addressing: "phone", baud: 300, public: true, private: false },
    bus: { name: "bus", kind: "local", addressing: "name", baud: null, public: false, private: true },
  },
  nodes: {
    school: {
      id: "school", title: "GOOSE LAKE", source: "manifest",
      networks: {
        pstn: { address: "(206) 555-0142", protocol: "SYSTEM/1" },
        bus: { address: "SCHOOL", protocol: "SYSTEM/1" },
      },
      mounts: [], peers: ["school-db"], state: "ephemeral", callable_by: null,
    },
    "school-db": {
      id: "school-db", title: "RECORDS", source: "manifest",
      networks: { bus: { address: "SCHOOL-DB", protocol: "SYSTEM/1" } },
      mounts: [], peers: [], state: "persistent", callable_by: ["school"],
    },
    wopr: {
      id: "wopr", title: "W.O.P.R.", source: "pack.json",
      networks: { pstn: { address: "(311) 486-0623", protocol: "SYSTEM/1" } },
      mounts: ["games/*"], peers: [], state: "ephemeral", callable_by: null,
    },
  },
  problems: [
    { level: "warning", code: "composite-host", message: "wopr: no period source yet" },
  ],
};

test("map: every network is listed with how it behaves", () => {
  const out = renderMap(TOPO);
  assert.match(out, /network pstn\s+dialup, phone, 300 baud/);
  assert.match(out, /network bus\s+local, name, private/);
});

test("map: a node on two networks shows both lines", () => {
  const out = renderMap(TOPO);
  assert.match(out, /node\s+school\s+-> pstn\s+\(206\) 555-0142/);
  assert.match(out, /-> bus\s+SCHOOL$/m);
});

test("map: a store says so, and says who may call it", () => {
  assert.match(renderMap(TOPO), /school-db.*\(store, callable by school\)/);
});

test("map: peers and mounts are shown", () => {
  const out = renderMap(TOPO);
  assert.match(out, /calls\s+school-db/);
  assert.match(out, /mounts\s+games\/\*/);
});

test("map: the composite-host warning is surfaced, not buried", () => {
  assert.match(renderMap(TOPO), /warning composite-host: wopr/);
});

test("map: an error is rendered distinctly from a warning", () => {
  const broken: Topology = {
    ...TOPO,
    problems: [{ level: "error", code: "duplicate-address", message: "two nodes, one line" }],
  };
  const out = renderMap(broken);
  assert.match(out, /ERROR\s+duplicate-address/);
});

test("errorsOf and warningsOf split the problems", () => {
  const mixed: Topology = {
    ...TOPO,
    problems: [
      { level: "warning", code: "composite-host", message: "w" },
      { level: "error", code: "unknown-peer", message: "e" },
    ],
  };
  assert.equal(errorsOf(mixed).length, 1);
  assert.equal(warningsOf(mixed).length, 1);
});
