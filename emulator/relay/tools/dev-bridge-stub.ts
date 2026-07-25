// DEV-ONLY bridge stand-in (test double) so the Home Terminal can be driven
// end-to-end through the comms layer before the real bridge lands (T3).
// It implements only the bridge's WS *contract* (api-contract.md §3): envelope
// in, envelope out. Canned WOPR-flavored responses; no routing, no core, no DB.
//
//   node tools/dev-bridge-stub.ts   # listens on :8000
//
// NOT shipped, NOT part of the module's public surface.

import { WebSocketServer } from "ws";
import { decodeEnvelope, encodeEnvelope, reassemble, type Envelope } from "../src/envelope.ts";

const PORT = Number(process.env.DEV_BRIDGE_PORT ?? 8000);

const respond = (input: string): string => {
  const cmd = input.trim().toUpperCase();
  if (cmd === "LOGON" || cmd.startsWith("LOGON ")) {
    return "IDENTIFICATION NOT RECOGNIZED BY SYSTEM\n--CONNECTION TERMINATED--\n\n(JUST KIDDING. TRY: HELP GAMES)";
  }
  if (cmd === "HELP GAMES" || cmd === "LIST GAMES") {
    return [
      "FALKEN'S MAZE", "BLACK JACK", "GIN RUMMY", "HEARTS", "BRIDGE",
      "CHECKERS", "CHESS", "POKER", "FIGHTER COMBAT", "GUERRILLA ENGAGEMENT",
      "DESERT WARFARE", "AIR-TO-GROUND ACTIONS", "THEATERWIDE TACTICAL WARFARE",
      "THEATERWIDE BIOTOXIC AND CHEMICAL WARFARE", "",
      "GLOBAL THERMONUCLEAR WAR", "", "TIC-TAC-TOE",
    ].join("\n");
  }
  if (cmd.includes("JOSHUA")) {
    return "GREETINGS PROFESSOR FALKEN.\n\nSHALL WE PLAY A GAME?";
  }
  return "SHALL WE PLAY A GAME?";
};

const wss = new WebSocketServer({ port: PORT });
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
console.log(`dev-bridge-stub listening on :${PORT} (WOPR canned responses)`);
