#!/usr/bin/env node
// wopr — bring up the federation the pack declares, and look at it.
//
//   wopr up [--fresh]      start every relay and every node
//   wopr map               print the topology without starting anything
//   wopr node <id>         run one node against relays already running
//
// `wopr dial` arrives with the terminal client.

import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { loadTopology, errorsOf, pythonFor, TopologyError } from "./topology.ts";
import { renderMap } from "./map.ts";
import { up } from "./up.ts";

const USAGE = `wopr — the W.O.P.R. federation

  wopr up [--fresh]     start one relay per network and one process per node
  wopr map              print the topology; start nothing
  wopr node <id>        run a single node against relays already running

  --pack <dir>          pack root (default: cwd)
`;

function packRootFrom(argv: string[]): string {
  const i = argv.indexOf("--pack");
  return resolve(i >= 0 && argv[i + 1] ? argv[i + 1] : process.cwd());
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return command ? 0 : 2;
  }

  const packRoot = packRootFrom(argv);

  if (command === "node") {
    const id = argv[1];
    if (!id) { process.stderr.write("wopr: which node?\n"); return 2; }
    const proc = spawn(pythonFor(packRoot),
      ["-m", "app.noderun", "--pack", packRoot, "--node", id],
      { cwd: `${packRoot}/emulator/node`, stdio: "inherit",
        env: { ...process.env, WOPR_NODE: id } });
    return await new Promise((r) => proc.once("exit", (code) => r(code ?? 0)));
  }

  let topo;
  try {
    topo = await loadTopology(packRoot);
  } catch (err) {
    process.stderr.write(`wopr: ${(err as TopologyError).message}\n`);
    return 2;
  }

  if (command === "map") {
    process.stdout.write(renderMap(topo) + "\n");
    return errorsOf(topo).length ? 1 : 0;
  }

  if (command === "up") {
    const fresh = argv.includes("--fresh");
    let running;
    try {
      running = await up(packRoot, topo, { fresh });
    } catch (err) {
      process.stderr.write(`wopr: ${(err as Error).message}\n`);
      return 1;
    }
    process.stdout.write("\nup. ^C to stop.\n");
    await new Promise<void>((resolve) => {
      for (const sig of ["SIGINT", "SIGTERM"] as const) {
        process.on(sig, () => { void running.stop().then(() => resolve()); });
      }
    });
    return 0;
  }

  process.stderr.write(`wopr: unknown command ${JSON.stringify(command)}\n${USAGE}`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
