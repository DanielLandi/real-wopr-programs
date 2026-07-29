// The console renderer: a real terminal on one end of the line.
//
// Everything terminal-shaped lives here and nowhere else. protocol.ts knows
// nothing about a TTY, which is what lets sub-project #4 hang an xterm.js
// renderer off the same protocol without forking it.

import { createInterface } from "node:readline";
import { dial, type DialOpts } from "./protocol.ts";

export interface RenderOpts extends DialOpts {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Dial, then pump: the far end's text to stdout, typed lines to the far end.
 * Resolves with the reason the line ended.
 */
export async function runTerminal(
  relay: string, address: string, opts: RenderOpts = {},
): Promise<string> {
  const out = opts.output ?? process.stdout;
  const input = opts.input ?? process.stdin;

  out.write("RINGING...\n");
  const line = await dial(relay, address, {
    ...opts,
    // Repaint on every arrival: a system asks TEST: after each command, and
    // the question belongs on the input line each time, not only the first.
    onPrompt: (next) => { out.write(`\n${next} `); },
  });

  const rl = createInterface({ input, terminal: false });
  rl.on("line", (text) => line.send(text));

  const pump = (async () => {
    // Write chunks exactly as they arrive. At 300 baud the shaper delivers
    // fragments of a line, not whole lines — anything added here lands in the
    // middle of a word.
    for await (const chunk of line.output) out.write(chunk);
  })();

  const reason = await line.closed;
  rl.close();
  await pump;
  out.write(`\n${reason}\n`);
  return reason;
}
