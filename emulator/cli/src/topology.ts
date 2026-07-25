// Reading the topology, by asking the thing that owns it.
//
// The loader and its ten validation rules live in Python. Reimplementing them
// here would be two implementations of one contract, drifting quietly. So the
// CLI shells out and uses the exit code as the gate.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface NetworkDesc {
  name: string;
  kind: "dialup" | "leased" | "local";
  addressing: "phone" | "hostname" | "name";
  baud: number | null;
  public: boolean;
  private: boolean;
}

export interface NodeDesc {
  id: string;
  title: string;
  networks: Record<string, { address: string; protocol: string }>;
  mounts: string[];
  peers: string[];
  state: "ephemeral" | "persistent";
  callable_by: string[] | null;
  source: "manifest" | "pack.json";
}

export interface Problem {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface Topology {
  networks: Record<string, NetworkDesc>;
  nodes: Record<string, NodeDesc>;
  problems: Problem[];
}

export class TopologyError extends Error {
  // Written out longhand: this repo runs TypeScript through Node's strip-only
  // mode, which has no parameter properties.
  problems: Problem[];

  constructor(message: string, problems: Problem[] = []) {
    super(message);
    this.problems = problems;
  }
}

/** The interpreter the node host is installed into. */
export function pythonFor(packRoot: string): string {
  return process.env.WOPR_PYTHON ?? `${packRoot}/emulator/node/.venv/bin/python`;
}

export async function loadTopology(packRoot: string): Promise<Topology> {
  const python = pythonFor(packRoot);
  try {
    const { stdout } = await run(python, ["-m", "app.topologycli", "--pack", packRoot], {
      cwd: `${packRoot}/emulator/node`,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout) as Topology;
  } catch (err) {
    const e = err as { stdout?: string; code?: number; message: string };
    // Exit 1 with JSON on stdout means "loaded fine, but it is invalid" — the
    // useful case. Anything else is the loader itself failing.
    if (e.stdout) {
      try {
        const topo = JSON.parse(e.stdout) as Topology;
        return topo;
      } catch { /* fall through to the hard error */ }
    }
    throw new TopologyError(
      `could not read the topology (${python}): ${e.message}\n` +
      `Is the node host installed?  pip install -e "emulator/node[dev]"`,
    );
  }
}

export function errorsOf(t: Topology): Problem[] {
  return t.problems.filter((p) => p.level === "error");
}

export function warningsOf(t: Topology): Problem[] {
  return t.problems.filter((p) => p.level === "warning");
}
