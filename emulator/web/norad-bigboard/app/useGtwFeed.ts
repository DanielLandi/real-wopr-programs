// Session + observer-link plumbing shared by the board and the tracks
// monitor: mint a norad-bigboard session, OBSERVE GTW, parse GTW-FEED.
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { WoprLink, endpointFromQuery, type LinkEvent } from "@real-wopr/crt-kit";
import { parseFeed, type GtwFeed } from "./feed";

export const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Parse `?room=` against the bridge's room-code shape (exactly 6 characters
 *  from ROOM_ALPHABET — see normalize_room_code in the bridge). A malformed
 *  code is reported on-page instead of being forwarded to POST /api/session
 *  as an opaque 400. Deliberate per-surface duplicate: surface apps stay
 *  self-contained and share only the wire contract. */
export function roomCodeFromLocation(): { code?: string; malformed?: string } {
  if (typeof window === "undefined") return {};
  const raw = new URLSearchParams(window.location.search).get("room");
  if (!raw) return {};
  const code = raw.trim().toUpperCase();
  const valid = code.length === 6 && [...code].every((ch) => ROOM_ALPHABET.includes(ch));
  return valid ? { code } : { malformed: code.slice(0, 24) };
}

export function useGtwFeed(): {
  feed: GtwFeed | null;
  linkUp: boolean;
  roomFault: string | null;
} {
  const [feed, setFeed] = useState<GtwFeed | null>(null);
  const [linkUp, setLinkUp] = useState(false);
  const [roomFault, setRoomFault] = useState<string | null>(null);
  const buffer = useRef("");

  const onLinkEvent = useCallback((e: LinkEvent) => {
    if (e.type === "close") {
      setLinkUp(false);
      return;
    }
    if (e.type === "open") {
      setLinkUp(true);
      return;
    }
    if (e.type !== "frame") return;
    const f = e.frame;
    if (f.kind === "handshake") return; // internal-bus has no ritual
    if (f.kind !== "output") return;
    buffer.current += f.payload;
    if (!f.eom) return;
    const message = buffer.current;
    buffer.current = "";
    const parsed = parseFeed(message);
    if (parsed) setFeed(parsed);
  }, []);

  useEffect(() => {
    let link: WoprLink | null = null;
    let cancelled = false;
    (async () => {
      const room = roomCodeFromLocation();
      if (room.malformed !== undefined) {
        // Don't connect roomless when a room was asked for — surface the
        // bad code instead of an opaque 400 from the bridge.
        setRoomFault(room.malformed);
        return;
      }
      const apiBase = endpointFromQuery("api", process.env.NEXT_PUBLIC_API_URL) ?? "";
      const res = await fetch(`${apiBase}/api/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ surface: "norad-bigboard", room_code: room.code }),
      });
      if (!res.ok || cancelled) return;
      const s = (await res.json()) as { session_id: string; token: string };
      link = new WoprLink({
        url: endpointFromQuery("link", process.env.NEXT_PUBLIC_COMMS_URL),
        surface: "norad-bigboard",
        session: s.session_id,
        token: s.token,
      });
      const l = link;
      link.onEvent((e) => {
        // Announce what this console watches once the socket is actually
        // open (internal-bus has no handshake frames to wait for); the
        // bridge then relays the active GTW simulation (T5).
        if (e.type === "open") l.sendInput("OBSERVE GTW");
        onLinkEvent(e);
      });
      link.connect();
    })();
    return () => {
      cancelled = true;
      link?.hangup();
    };
  }, [onLinkEvent]);

  return { feed, linkUp, roomFault };
}
