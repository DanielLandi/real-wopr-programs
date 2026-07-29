// Dialling a line, and what comes back.
//
// This file must stay free of anything terminal-shaped: no process.stdout, no
// node:tty, no ANSI. Sub-project #4 puts an xterm.js renderer on this same
// module, and one protocol with two renderers only works if the protocol half
// never assumes a TTY.
//
// A caller sends raw text and receives Envelopes — the format the relay's
// caller leg already speaks, and the one the web surfaces have always decoded.

import { WebSocket } from "ws";

export interface Envelope {
  v: 1;
  session: string;
  seq: number;
  kind: "input" | "output" | "control" | "handshake" | "prompt";
  link: string;
  payload: string;
  eom: boolean;
}

export interface DialOpts {
  /** Who is calling. The callee's relay checks this against callable_by. */
  from?: string;
  signal?: AbortSignal;
  /** Called when the far end changes the prompt — i.e. the mode changed. */
  onPrompt?: (prompt: string) => void;
}

export interface Line {
  /** Text from the far end, paced by the network's profile. */
  output: AsyncIterableIterator<string>;
  /** Type at it. */
  send: (text: string) => void;
  /** Why the line ended, once it has. */
  closed: Promise<string>;
  hangUp: () => void;
  /** The prompt the far end last asked for — carries the current mode. */
  prompt: () => string;
}

export function dialUrl(relay: string, address: string, from: string): string {
  const q = new URLSearchParams({ address, from });
  return `${relay}/dial?${q.toString()}`;
}

/**
 * Dial `address` through `relay`.
 *
 * Resolves once the socket is open — which is the moment the far end's line is
 * ringing, not the moment it answers. A line nobody holds closes immediately
 * with NO ANSWER, and that arrives through `closed`.
 */
export async function dial(relay: string, address: string, opts: DialOpts = {}): Promise<Line> {
  const ws = new WebSocket(dialUrl(relay, address, opts.from ?? "console"));

  const queue: string[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let closeReason = "";
  let promptText = ">";
  let promptBuf = "";

  let resolveClosed: (reason: string) => void;
  const closed = new Promise<string>((r) => { resolveClosed = r; });

  ws.on("message", (raw: Buffer | string) => {
    let env: Envelope;
    try {
      env = JSON.parse(raw.toString()) as Envelope;
    } catch {
      return;   // a frame we cannot read is not a reason to drop the call
    }
    if (env.kind === "prompt") {
      // Not teletype text: it belongs on the input line, not the transcript.
      // Reassemble per message first (comms-protocol.md §5). Output survives
      // chunking because it appends; a prompt replaces, so at dialup-300's
      // two-byte quantum "[TTT]>" would arrive as "]>".
      promptBuf += env.payload;
      if (!env.eom) return;
      promptText = promptBuf || ">";
      promptBuf = "";
      opts.onPrompt?.(promptText);
      return;
    }
    if (env.payload) {
      queue.push(env.payload);
      notify?.();
    }
  });

  ws.on("close", (_code: number, reason: Buffer) => {
    closeReason = reason.toString() || "NO CARRIER";
    done = true;
    notify?.();
    resolveClosed(closeReason);
  });

  ws.on("error", () => {
    // A refused or broken connection ends the call the same way a hang-up
    // does; the caller does not need to tell those apart.
    if (!done) {
      closeReason ||= "NO CARRIER";
      done = true;
      notify?.();
      resolveClosed(closeReason);
    }
  });

  opts.signal?.addEventListener("abort", () => ws.close());

  await new Promise<void>((resolve) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once("open", () => resolve());
    ws.once("close", () => resolve());
    ws.once("error", () => resolve());
  });

  async function* output(): AsyncIterableIterator<string> {
    while (true) {
      while (queue.length) yield queue.shift()!;
      if (done) return;
      await new Promise<void>((r) => { notify = () => { notify = null; r(); }; });
    }
  }

  return {
    output: output(),
    send: (text: string) => {
      // A caps-only 1983 terminal: everything typed goes out uppercase.
      if (ws.readyState === WebSocket.OPEN) ws.send(text.toUpperCase());
    },
    closed,
    hangUp: () => ws.close(),
    prompt: () => promptText,
  };
}
