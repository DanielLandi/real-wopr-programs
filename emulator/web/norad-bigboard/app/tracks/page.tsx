"use client";
// TACTICAL TRACKS — the screen wall's fourth monitor (#39): the Big Board's
// feed as a dense tabular readout, not a second vector map.

import { CRTScreen, StatusPanel } from "@real-wopr/crt-kit";
import { ROOM_ALPHABET, useGtwFeed } from "../useGtwFeed";
import { targetLine, trackRows } from "../tracks";

const cell = { padding: "0.15em 1.2em 0.15em 0", whiteSpace: "nowrap" } as const;

export default function TacticalTracks() {
  const { feed, linkUp, roomFault } = useGtwFeed();
  const rows = feed ? trackRows(feed) : [];
  const targets = feed ? targetLine(feed) : null;

  return (
    <CRTScreen theme="green" flicker={false}>
      <StatusPanel
        items={[
          { label: "TACTICAL TRACKS", value: feed ? feed.status : "STANDBY" },
          { label: "ZULU", value: feed?.clock ?? "--:--" },
          { label: "DEFCON", value: String(feed?.defcon ?? 5) },
          { label: "IMPACT", value: feed?.impact ?? "--:--" },
          { label: "LINK", value: linkUp ? "BUS OK" : "DOWN" },
        ]}
      />

      {roomFault !== null && (
        <div style={{ marginTop: "0.8em", letterSpacing: "0.1em", color: "#ffd23c" }}>
          INVALID ROOM CODE &quot;{roomFault}&quot; — ROOM CODES ARE 6 CHARACTERS FROM {ROOM_ALPHABET}.
          CORRECT THE ?room= PARAMETER AND RELOAD.
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ marginTop: "2em", letterSpacing: "0.2em", opacity: 0.7 }}>
          NO TRACKS AIRBORNE
        </div>
      ) : (
        <table style={{ marginTop: "1em", borderCollapse: "collapse", letterSpacing: "0.08em" }}>
          <thead>
            <tr style={{ opacity: 0.7 }}>
              {["ID", "TYP", "SIDE", "FROM", "TO", "PROG"].map((h) => (
                <th key={h} style={{ ...cell, textAlign: "left", borderBottom: "1px solid var(--crt-dim)" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={{ color: r.side === "SU" ? "#ff8c5a" : "inherit" }}>
                <td style={cell}>{r.id}</td>
                <td style={cell}>{r.typ}</td>
                <td style={cell}>{r.side || "--"}</td>
                <td style={cell}>{r.from[0]} {r.from[1]}</td>
                <td style={cell}>{r.to[0]} {r.to[1]}</td>
                <td style={cell}>{r.progress.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {targets !== null && (
        <div style={{ marginTop: "0.8em", color: "#ffd23c", letterSpacing: "0.1em" }}>{targets}</div>
      )}
      {(feed?.events?.length ?? 0) > 0 && (
        <div style={{ marginTop: "0.8em", borderTop: "1px solid var(--crt-dim)", paddingTop: "0.5em" }}>
          {(feed?.events ?? []).slice(-4).map((line, i) => (
            <div key={i} style={{ opacity: 0.85 }}>{line}</div>
          ))}
        </div>
      )}
    </CRTScreen>
  );
}
