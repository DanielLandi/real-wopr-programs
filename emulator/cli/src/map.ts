// `wopr map` — the federation on paper, without starting anything.

import { errorsOf, warningsOf, type Topology } from "./topology.ts";

/** Render the topology as the operator's map. Pure, so it is testable. */
export function renderMap(t: Topology): string {
  const out: string[] = [];

  for (const [name, net] of Object.entries(t.networks)) {
    const bits: string[] = [net.kind, net.addressing];
    if (net.baud) bits.push(`${net.baud} baud`);
    if (net.private) bits.push("private");
    out.push(`network ${name.padEnd(8)} ${bits.join(", ")}`);
  }
  out.push("");

  for (const node of Object.values(t.nodes)) {
    const nets = Object.entries(node.networks);
    const notes: string[] = [];
    if (node.state === "persistent") notes.push("store");
    if (node.callable_by) notes.push(`callable by ${node.callable_by.join(", ")}`);
    const suffix = notes.length ? `   (${notes.join(", ")})` : "";

    const [first, ...rest] = nets;
    out.push(`node    ${node.id.padEnd(14)} -> ${first[0].padEnd(6)} ${first[1].address}${suffix}`);
    for (const [net, addr] of rest) {
      out.push(`${" ".repeat(8)}${" ".repeat(14)} -> ${net.padEnd(6)} ${addr.address}`);
    }
    if (node.mounts.length) {
      out.push(`${" ".repeat(8)}${" ".repeat(14)}    mounts ${node.mounts.join(", ")}`);
    }
    if (node.peers.length) {
      out.push(`${" ".repeat(8)}${" ".repeat(14)}    calls  ${node.peers.join(", ")}`);
    }
  }

  const warnings = warningsOf(t);
  const errors = errorsOf(t);
  if (warnings.length || errors.length) out.push("");
  for (const w of warnings) out.push(`warning ${w.code}: ${w.message}`);
  for (const e of errors) out.push(`ERROR   ${e.code}: ${e.message}`);

  return out.join("\n");
}
