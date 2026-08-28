// One end of a machine call that is a program.
//
// A machine answering a machine should not be a special code path: it mints an
// ordinary bridge session and dials an ordinary /link, so it gets the same
// ritual, the same pacing and the same program a visitor's call gets. The only
// thing that differs is who dialled.
//
// Three call sites: the callee tieline (an inbound machine call), the caller
// tieline (a call this host placed), and the hub's own seeded world-1 slots.
// Written once, because the copy nobody runs in a test is the one that rots.

import { WebSocket } from "ws";
import { encodeEnvelope, decodeEnvelope } from "./envelope.ts";

export interface LocalLegOpts {
  bridgeUrl: string;
  commsUrl: string;
  surface: "trunk-call" | "trunk-caller";
  system?: string;
  /** Who called, as the program will be told: "world 1 slot PANAM" or
   *  "seat <handle>". The ONE way a program learns this, on every path —
   *  including the seeded-slot path, where no OPEN exists to carry a field. */
  origin?: string;
  /** Caller side. The answering end's handshake and control frames travel back
   *  over the trunk (that is how a visitor sees CARRIER DETECT), but a calling
   *  PROGRAM must not be handed them as input: no period program ever had to
   *  answer its own modem. Enforced on the INBOUND path (`deliver`), which is
   *  the direction that carries them; the outbound path is filtered too, where
   *  it keeps a program's own control traffic off the trunk. */
  filterRitual?: boolean;
  send: (data: string) => void;
  close: (reason?: string) => void;
}

export interface LocalLeg {
  deliver(data: string): void;
  close(reason?: string): void;
}

export async function openLocalLeg(opts: LocalLegOpts): Promise<LocalLeg | "refused"> {
  let minted: { session_id: string; token: string };
  try {
    const res = await fetch(`${opts.bridgeUrl}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ surface: opts.surface, system: opts.system ?? null }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) { opts.close("no session"); return "refused"; }
    minted = await res.json() as { session_id: string; token: string };
  } catch {
    opts.close("no session"); return "refused";
  }

  const url = `${opts.commsUrl}/link?surface=${encodeURIComponent(opts.surface)}` +
              `&session=${encodeURIComponent(minted.session_id)}` +
              `&token=${encodeURIComponent(minted.token)}`;
  const local = new WebSocket(url);
  const buffer: string[] = [];
  let open = false;

  /** Only what a program should read. Anything that will not decode into a
   *  kind we can classify is not handed to one either. */
  const forProgram = (text: string): boolean => {
    try {
      const kind = decodeEnvelope(text).kind;
      return kind === "output" || kind === "prompt";
    } catch {
      return false;
    }
  };

  const push = (data: string) => {
    // INBOUND is where the ritual actually is. The far end's `/link` runs the
    // dial FSM and its DIALING/RINGING/CARRIER DETECT frames travel back over
    // the trunk to here — that is how a visitor sees a modem connect, and it
    // is exactly what a calling PROGRAM must never be handed as input. Filter
    // on the way IN, not only on the way out.
    if (opts.filterRitual && !forProgram(data)) return;
    if (open) local.send(data); else buffer.push(data);
  };

  local.on("open", () => {
    open = true;
    // The origin goes first, ahead of anything the far end already said. The
    // /link leg forwards an unrecognized control envelope straight upstream,
    // and buffers it if the bridge socket is not up yet, so this cannot race.
    if (opts.origin !== undefined) {
      local.send(encodeEnvelope({
        v: 1, session: minted.session_id, seq: 0, kind: "control",
        link: opts.surface, payload: `ORIGIN ${opts.origin}`, eom: true,
      }));
    }
    for (const d of buffer.splice(0)) local.send(d);
  });

  local.on("message", (data) => {
    const text = data.toString();
    // OUTBOUND. The caller's own surface is `trunk-caller` -> profile `off` ->
    // handshake "none", so this direction carries no ritual to drop; kept
    // because it stops a calling program's own control traffic crossing the
    // trunk. The guarantee the comment on `filterRitual` states lives in
    // `push` above.
    if (opts.filterRitual && !forProgram(text)) return;
    opts.send(text);
  });

  const drop = () => opts.close("local leg closed");
  local.on("close", drop);
  local.on("error", drop);

  return {
    deliver: push,
    close: () => { try { local.close(); } catch { /* already closed */ } },
  };
}
