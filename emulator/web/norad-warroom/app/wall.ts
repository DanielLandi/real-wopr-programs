// The NORAD screen wall — pure composition logic (docs/surfaces.md §5).
// The wall knows only the sibling surfaces' public routes; it never parses
// feeds or speaks a wire protocol (the federation boundary holds).

export const DESIGN_WIDTH = 1280;
export const DESIGN_HEIGHT = 800;

export interface Monitor {
  id: "bigboard" | "panel" | "norad" | "tracks";
  title: string;
  /** Iframe base URL (same-origin exported route by default; dev override
   *  via NEXT_PUBLIC_*_URL). `null` marks an offline bezel with no iframe. */
  base: string | null;
}

/** The wall's fixed monitor list: Big Board primary, panel and operator
 *  terminal secondary, plus the TACTICAL TRACKS monitor (#39) — the Big
 *  Board's feed as a tabular readout, exported under /bigboard/tracks/. */
export function monitors(
  env: { bigboard?: string; panel?: string; norad?: string; tracks?: string } = {},
): Monitor[] {
  return [
    { id: "bigboard", title: "BIG BOARD", base: env.bigboard ?? "/bigboard/" },
    { id: "panel", title: "WOPR PANEL", base: env.panel ?? "/panel/" },
    { id: "norad", title: "OPERATOR TERMINAL", base: env.norad ?? "/norad/" },
    { id: "tracks", title: "TACTICAL TRACKS", base: env.tracks ?? "/bigboard/tracks/" },
  ];
}

const ROOM_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export interface WallParams {
  room?: string;
  malformedRoom?: string;
  api?: string;
  link?: string;
}

/** Parse the wall's own query string. Room codes are validated against the
 *  bridge's shape (6 chars from ROOM_ALPHABET) so a malformed code is shown
 *  on-page instead of forwarded; `api`/`link` accept https:/wss: only (no
 *  downgrade). Deliberate per-surface duplicate of the sibling surfaces'
 *  guards: surface apps stay self-contained and share only the wire contract. */
export function wallParamsFromSearch(search: string): WallParams {
  const q = new URLSearchParams(search);
  const out: WallParams = {};
  const rawRoom = q.get("room");
  if (rawRoom) {
    const code = rawRoom.trim().toUpperCase();
    const valid = code.length === 6 && [...code].every((ch) => ROOM_ALPHABET.includes(ch));
    if (valid) out.room = code;
    else out.malformedRoom = code.slice(0, 24);
  }
  for (const key of ["api", "link"] as const) {
    const v = q.get(key);
    if (v && /^(https:|wss:)/.test(v)) out[key] = v;
  }
  return out;
}

/** Build a monitor iframe src: base route + shared room/exchange params,
 *  preserving any query already on the base. */
export function monitorSrc(
  base: string,
  params: { room?: string; api?: string; link?: string },
): string {
  const [path, query = ""] = base.split("?");
  const q = new URLSearchParams(query);
  if (params.room) q.set("room", params.room);
  if (params.api) q.set("api", params.api);
  if (params.link) q.set("link", params.link);
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

/** Scale that fits the fixed design frame (DESIGN_WIDTH×DESIGN_HEIGHT) inside
 *  a tile, preserving aspect. Surfaces are built full-screen; the wall shows
 *  them shrunk, and the focused monitor may scale past 1 on large displays. */
export function fitScale(tileW: number, tileH: number): number {
  if (tileW <= 0 || tileH <= 0) return 0;
  return Math.min(tileW / DESIGN_WIDTH, tileH / DESIGN_HEIGHT);
}
