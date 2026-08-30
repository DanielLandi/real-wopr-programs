// The one thing every fake bridge in this suite has to do since #80.
//
// A `/link` dial no longer takes the surface from the query string: the relay
// asks the bridge which surface the session actually is, and refuses the dial
// (`4403` mismatch, `4404` unknown, `4503` no answer) before it paces
// anything. So a fake bridge that is only a WebSocket endpoint is no longer a
// bridge a dial can get through — it has to answer `GET /api/session/{id}`
// too. This module is that answer, shared rather than copied into the five
// files that need it.
//
// The attack itself is NOT tested with these: `link-surface.test.ts` carries
// its own faithful bridge, which mints, remembers, and reports what it minted.
// These helpers exist so that tests about pacing, rituals, seats and trunks
// stay tests about pacing, rituals, seats and trunks.

import http from "node:http";
import { WebSocketServer } from "ws";
import { LOOPBACK } from "./loopback.ts";

/** Answer the session lookup, or say this was not a lookup at all.
 *
 * `surfaceOf` returns the stored surface for an id, or `undefined` for a 404. */
export function answerSessionLookup(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  surfaceOf: (id: string) => string | undefined,
): boolean {
  const match = /^\/api\/session\/([^/?]+)$/.exec(req.url ?? "");
  if (req.method !== "GET" || !match) return false;
  const surface = surfaceOf(decodeURIComponent(match[1]!));
  if (surface === undefined) { res.writeHead(404); res.end(); return true; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ surface }));
  return true;
}

/** An HTTP face for a fake bridge that had none: it answers the session
 *  lookup and 500s everything else.
 *
 *  A constant `surface` answers for every id, including ids nothing ever
 *  minted — the tests that use this dial with hand-written session ids and
 *  care about the ritual, not about who minted what. */
export function sessionLookupServer(
  surfaceOf: string | ((id: string) => string | undefined),
): http.Server {
  const lookup = typeof surfaceOf === "string" ? () => surfaceOf : surfaceOf;
  return http.createServer((req, res) => {
    if (answerSessionLookup(req, res, lookup)) return;
    res.writeHead(500);
    res.end();
  });
}

export interface LookupBridge {
  port: number;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

/** The whole thing: a WebSocket bridge whose port also answers the lookup.
 *  Replaces a bare `new WebSocketServer({ port: 0 })` used as a fake bridge. */
export function lookupBridge(
  surfaceOf: string | ((id: string) => string | undefined),
  onConnection?: Parameters<WebSocketServer["on"]>[1],
): Promise<LookupBridge> {
  const server = sessionLookupServer(surfaceOf);
  const wss = new WebSocketServer({ server });
  if (onConnection) wss.on("connection", onConnection);
  return new Promise((resolve) => {
    server.listen(0, LOOPBACK, () => resolve({
      port: (server.address() as { port: number }).port,
      wss,
      close: () => new Promise<void>((done) => {
        for (const c of wss.clients) c.terminate();
        server.close(() => done());
      }),
    }));
  });
}
