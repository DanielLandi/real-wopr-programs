// `wopr up` — start one relay per network, then one process per node.
//
// Relays first, because nodes dial out to them. Ports are ephemeral and passed
// to children by env, so nothing hardcodes one and two federations can run side
// by side.

import { spawn, type ChildProcess } from "node:child_process";
import { errorsOf, warningsOf, pythonFor, type Topology } from "./topology.ts";

export interface Supervised {
  relays: Map<string, { port: number; address: string; proc: ChildProcess }>;
  nodes: Map<string, ChildProcess>;
  stop: () => Promise<void>;
}

// Wide enough for the longest 'node <id>' in the pack, plus a space so a
// long id never runs into its own output.
const PREFIX_WIDTH = 20;

function pipe(name: string, proc: ChildProcess, out: NodeJS.WritableStream): void {
  const tag = `${name} `.padEnd(PREFIX_WIDTH);
  for (const stream of [proc.stdout, proc.stderr]) {
    stream?.setEncoding("utf8");
    let buf = "";
    stream?.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) out.write(`${tag}${line}\n`);
    });
  }
}

/** Start one relay and wait for the line telling us which port it took. */
async function startRelay(
  packRoot: string, desc: Topology["networks"][string], out: NodeJS.WritableStream,
): Promise<{ port: number; address: string; proc: ChildProcess }> {
  const proc = spawn("node", ["src/network-main.ts"], {
    cwd: `${packRoot}/emulator/relay`,
    env: { ...process.env, WOPR_NETWORK: JSON.stringify(desc), WOPR_RELAY_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const listening = await new Promise<{ port: number; address: string }>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/^listening (\S+) (\S+):(\d+)$/m);
      if (m) {
        proc.stdout?.off("data", onData);
        resolve({ address: m[2], port: Number(m[3]) });
      }
    };
    proc.stdout?.on("data", onData);
    proc.once("exit", (code) =>
      reject(new Error(`relay ${desc.name} exited before listening (code ${code})`)));
    setTimeout(() => reject(new Error(`relay ${desc.name} did not start in time`)), 15_000);
  });

  pipe(`relay ${desc.name}`, proc, out);
  return { ...listening, proc };
}

export async function up(
  packRoot: string,
  topo: Topology,
  opts: { fresh?: boolean; out?: NodeJS.WritableStream } = {},
): Promise<Supervised> {
  const out = opts.out ?? process.stdout;

  // A mis-declared federation fails where it is declared, not halfway through a
  // call. Warnings are printed and do not block — that is what keeps the
  // composite-host waiting room visible rather than comfortable.
  const errors = errorsOf(topo);
  for (const w of warningsOf(topo)) out.write(`warning ${w.code}: ${w.message}\n`);
  if (errors.length) {
    for (const e of errors) out.write(`ERROR   ${e.code}: ${e.message}\n`);
    throw new Error(`topology has ${errors.length} error(s); nothing was started`);
  }

  const relays = new Map<string, { port: number; address: string; proc: ChildProcess }>();
  const nodes = new Map<string, ChildProcess>();

  let stopping = false;
  const stop = async () => {
    stopping = true;
    for (const p of [...nodes.values(), ...[...relays.values()].map((r) => r.proc)]) {
      p.kill("SIGTERM");
    }
    await new Promise((r) => setTimeout(r, 150));
  };

  try {
    for (const desc of Object.values(topo.networks)) {
      const r = await startRelay(packRoot, desc, out);
      relays.set(desc.name, r);
      out.write(`  relay ${desc.name.padEnd(8)} ${r.address}:${r.port}` +
                `${desc.private ? " (loopback)" : ""}\n`);
    }

    const relayEnv: Record<string, string> = {};
    for (const [name, r] of relays) {
      relayEnv[`WOPR_RELAY_${name.toUpperCase()}`] = `ws://127.0.0.1:${r.port}`;
    }

    for (const node of Object.values(topo.nodes)) {
      // A composite host mounts others and needs the router; the node host
      // serves a node that is itself a program. Skip rather than pretend.
      if (node.source === "pack.json") {
        out.write(`  node  ${node.id.padEnd(14)} skipped — no period source yet (#112)\n`);
        continue;
      }
      const args = ["-m", "app.noderun", "--pack", packRoot, "--node", node.id];
      if (opts.fresh) args.push("--fresh");
      const proc = spawn(pythonFor(packRoot), args, {
        cwd: `${packRoot}/emulator/node`,
        env: { ...process.env, ...relayEnv, WOPR_NODE: node.id },
        stdio: ["ignore", "pipe", "pipe"],
      });
      pipe(`node ${node.id}`, proc, out);
      proc.once("exit", (code) => {
        if (!stopping) out.write(`node ${node.id} exited (code ${code})\n`);
      });
      nodes.set(node.id, proc);

      const lines = Object.entries(node.networks)
        .map(([net, a]) => `${net} ${a.address}`).join(", ");
      out.write(`  node  ${node.id.padEnd(14)} -> ${lines}\n`);
    }
  } catch (err) {
    await stop();
    throw err;
  }

  return { relays, nodes, stop };
}
