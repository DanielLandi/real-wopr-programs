// The phone book (docs/fidelity-notes.md follow-up; site: real-wopr-site).
// A directory of community-run WOPR "exchanges" — each entry is someone's
// self-hosted comms+bridge+core. The terminal reads a small CONFIG file
// (phonebook.json) served next to this export, so the directory's source can
// change without rebuilding:
//
//   { "source": "static", "exchanges": [ ... ] }
//   { "source": "api",    "api_base": "https://bridge.example" }
//
// api mode reads GET {api_base}/api/exchanges from the bridge (approved
// rows only — the bridge's own store is the security boundary).
//
// An optional `trunk_directory` URL points at a comms hub's
// `GET /trunk/directory` — live federated exchanges merged in behind the
// book's own entries (one line per machine: see `dedupe`). The
// hub groups those entries into worlds, and each entry carries the world and
// slot it was placed in; the DIRECTORY screen prints them under world
// headings.

export interface Exchange {
  id: string;
  name: string;         // e.g. "CHEYENNE MOUNTAIN (HOMELAB)"
  region: string;       // e.g. "SAO PAULO BR"
  api: string;          // https base for POST /api/session (no trailing slash)
  link: string;         // wss URL of the comms layer's /link
  joshua: "claude" | "period";
  operator?: string;    // GitHub handle
  world?: number;       // trunk world this exchange was placed in
  slot?: string;        // its role in that world (WOPR, SCHOOL, PANAM, ...)
  /** Bridge system id (`POST /api/session { system }`), on an entry whose slot
   *  is a period system rather than a Joshua line. The hub sets it on the
   *  slots it seeds into world 1; dialling such an entry opens a system
   *  session instead of a WOPR one. */
  system?: string;
}

interface PhonebookConfig {
  source: "static" | "api";
  exchanges?: Exchange[];
  api_base?: string;
  trunk_directory?: string;
}

/** Where the config lives: site root when the terminal is exported under
 *  /terminal/, overridable at build time. */
const PHONEBOOK_URL = process.env.NEXT_PUBLIC_PHONEBOOK_URL ?? "../phonebook.json";

/** Entry gate (exported for tests). Beyond shape, endpoints are scheme-checked
 *  the same way the observer surfaces vet `?api=`/`?link=` overrides and the
 *  bridge's own store CHECKs its rows: api must be https:, link must be wss:.
 *  A hostile trunk registrant or malformed directory
 *  response must not be able to make the terminal dial a downgraded
 *  http:/ws: endpoint.
 *
 *  `system` is the one field that is repaired rather than fatal: it only
 *  decides which KIND of session a dial mints, so a malformed one costs the
 *  entry its system tag (it dials as an ordinary WOPR line) instead of costing
 *  the caller a dialable exchange. */
export function valid(list: unknown): Exchange[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(
      (e): e is Exchange =>
        !!e && typeof e.name === "string" && typeof e.region === "string" &&
        typeof e.api === "string" && e.api.startsWith("https://") &&
        typeof e.link === "string" && e.link.startsWith("wss://"),
    )
    .map((e) => {
      if (e.system === undefined || typeof e.system === "string") return e;
      const { system: _bad, ...rest } = e;
      return rest;
    });
}

/** Live entries from the comms hub's trunk directory (`GET /trunk/directory`
 *  → `{ worlds: [{ n, slots: DirectoryEntry[] }] }`, each entry already
 *  phone-book Exchange-shaped and tagged with its `world`/`slot`). Flattened
 *  in world order, so the book keeps one list and the DIRECTORY screen can
 *  re-group it by the tags. Degrades silently — an unreachable or slow trunk
 *  never blocks the book. */
async function trunkEntries(url: string | undefined): Promise<Exchange[]> {
  if (!url) return [];
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3500) });
    if (!res.ok) return [];
    const dir = (await res.json()) as { worlds?: Array<{ slots?: unknown }> };
    const flat = Array.isArray(dir.worlds)
      ? dir.worlds.flatMap((w) => (Array.isArray(w.slots) ? w.slots : []))
      : [];
    return valid(flat);
  } catch {
    return [];
  }
}

/** An exchange IS its api endpoint: case-folded, trailing slashes dropped —
 *  the same fold the bridge applies when it refuses a second id for an api
 *  already in its book (#101). */
function endpoint(e: Exchange): string {
  return e.api.toLowerCase().replace(/\/+$/, "");
}

/** Merge live trunk entries in behind the book's own entries. One line per
 *  machine, decided two ways:
 *
 *  - Same `id`: the book wins, the trunk entry drops. A trunk registrant that
 *    claims a book id must not be able to swap that row's endpoints.
 *  - Same endpoint, different id: the TRUNK entry wins, the book row drops.
 *    Two ids for one `api` are one machine — the hub's seeded world-1 slot
 *    (`local-wopr`, an id the hub derives from the slot) beside the same
 *    box's hand-typed registry row (`homelab-sp`, before the bridge learned
 *    to refuse it). The live entry is the one answering, carries the world
 *    and slot tags DIRECTORY prints under, and its id is the pack's; keeping
 *    the book row instead printed the flagship twice, the second time as a
 *    [NO CARRIER] line beneath its own answering one. Endpoint equality is
 *    what makes this safe: whichever row survives, a dial lands on the same
 *    machine. */
export function dedupe(primary: Exchange[], extra: Exchange[]): Exchange[] {
  const ids = new Set(primary.map((e) => e.id));
  const live = extra.filter((e) => !ids.has(e.id));
  const answering = new Set(live.map(endpoint));
  return [...primary.filter((e) => !answering.has(endpoint(e))), ...live];
}

export async function loadExchanges(): Promise<Exchange[] | null> {
  try {
    const res = await fetch(PHONEBOOK_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as PhonebookConfig;
    if (cfg.source === "api" && cfg.api_base) {
      // No data dependency between the book rows and the live trunk merge —
      // fetch both at once. trunkEntries degrades to [] on its own failures,
      // so only the bridge leg decides success vs [], same as before.
      const [r, trunk] = await Promise.all([
        fetch(`${cfg.api_base.replace(/\/$/, "")}/api/exchanges`, { cache: "no-store" }),
        trunkEntries(cfg.trunk_directory),
      ]);
      if (!r.ok) return [];
      const body = (await r.json()) as { exchanges?: unknown };
      const rows = Array.isArray(body.exchanges) ? body.exchanges : [];
      return dedupe(valid(rows), trunk);
    }
    if (cfg.source === "static") {
      return dedupe(valid(cfg.exchanges), await trunkEntries(cfg.trunk_directory));
    }
    return null;
  } catch {
    return null; // no phonebook -> classic same-origin single-exchange mode
  }
}

/** War-dialer probe: is anyone answering at this exchange? */
export async function probe(e: Exchange, timeoutMs = 3500): Promise<boolean> {
  try {
    const res = await fetch(`${e.api}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
