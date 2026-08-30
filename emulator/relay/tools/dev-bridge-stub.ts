// DEV-ONLY bridge stand-in (test double) so the Home Terminal can be driven
// end-to-end through the comms layer before the real bridge lands (T3).
// It implements only the bridge's WS *contract* (api-contract.md §3): envelope
// in, envelope out. Canned WOPR-flavored responses; no routing, no core, no DB.
//
//   node tools/dev-bridge-stub.ts   # listens on :8000
//
// NOT shipped, NOT part of the module's public surface.

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

const PORT = Number(process.env.DEV_BRIDGE_PORT ?? 8000);

const respond = (input: string): string => {
  const cmd = input.trim().toUpperCase();
  if (cmd === "LOGON" || cmd.startsWith("LOGON ")) {
    // INDENTIFICATION (sic) — the film's own misspelling, as in the router.
    return "INDENTIFICATION NOT RECOGNIZED BY SYSTEM\n--CONNECTION TERMINATED--\n\n(JUST KIDDING. TRY: LIST GAMES)";
  }
  if (cmd === "HELP GAMES") {
    return "'GAMES' REFERS TO MODELS, SIMULATIONS AND GAMES\nWHICH HAVE TACTICAL AND STRATEGIC APPLICATIONS.";
  }
  if (cmd === "LIST GAMES") {
    // The film's recitation ends on GLOBAL THERMONUCLEAR WAR and never says
    // TIC-TAC-TOE — the real router's list_games_text agrees.
    return [
      "FALKEN'S MAZE", "BLACK JACK", "GIN RUMMY", "HEARTS", "BRIDGE",
      "CHECKERS", "CHESS", "POKER", "FIGHTER COMBAT", "GUERRILLA ENGAGEMENT",
      "DESERT WARFARE", "AIR-TO-GROUND ACTIONS", "THEATERWIDE TACTICAL WARFARE",
      "THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE", "",
      "GLOBAL THERMONUCLEAR WAR",
    ].join("\n");
  }
  if (cmd.includes("JOSHUA")) {
    return "GREETINGS PROFESSOR FALKEN.\n\nSHALL WE PLAY A GAME?";
  }
  return "SHALL WE PLAY A GAME?";
};

// The REST face. A `/link` dial asks the bridge which surface a session is
// before it paces anything (#80), so a bridge stand-in that is only a socket
// is one every dial refuses `4503`. Minting is answered too, so the surfaces
// can be driven against this stub end to end rather than half of it.
let minted = 0;
const http = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/session") {
    req.resume();
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ session_id: `dev-${++minted}`, token: "dev-token",
                             link_profile: "dialup-300", room_code: null,
                             system: null, joshua: "dev" }));
    return;
  }
  if (req.method === "GET" && /^\/api\/session\/[^/?]+$/.test(req.url ?? "")) {
    // Every dev session is a front-door one: this stub has no store to
    // remember anything else, and the surfaces all dial `home-terminal`.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ surface: "home-terminal", defcon: 5,
                             link_profile: "dialup-300", room_code: null,
                             system: null, last_seen_at: null }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http });
wss.on("connection", (ws, req) => {
  console.log(`dev-bridge: session connected ${req.url}`);
  const buffer: Envelope[] = [];
  ws.on("message", (data) => {
    try {
      const e = decodeEnvelope(data.toString());
      if (e.kind !== "input") return;
      buffer.push(e);
      if (!e.eom) return;
      const [msg] = reassemble(buffer.splice(0));
      ws.send(encodeEnvelope({
        v: 1, session: e.session, seq: 0, kind: "output",
        link: e.link, payload: `\n${respond(msg)}\n`, eom: true,
      }));
    } catch {
      /* ignore malformed dev traffic */
    }
  });
});
http.listen(PORT, () =>
  console.log(`dev-bridge-stub listening on :${PORT} (WOPR canned responses)`));
