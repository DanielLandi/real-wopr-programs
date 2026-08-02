// The phone book (docs/fidelity-notes.md follow-up; site: real-wopr-site).
// A directory of community-run WOPR "exchanges" — each entry is someone's
// self-hosted comms+bridge+core. The terminal reads a small CONFIG file
// (phonebook.json) served next to this export, so the directory's source can
// change without rebuilding:
//
//   { "source": "static",   "exchanges": [ ... ] }
//   { "source": "supabase", "url": "https://<ref>.supabase.co",
//     "anon_key": "<public anon key>" }
//
// Supabase mode reads the `exchanges` table via PostgREST (RLS: approved
// rows only — db/migrations/0002_exchanges.sql). The anon key is public by
// design; RLS is the security boundary.
//
// An optional `trunk_directory` URL points at a comms hub's
// `GET /trunk/directory` — live federated exchanges merged in behind the
// book's own entries (dedupe by id; the book always wins on collision). The
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
}

interface PhonebookConfig {
  source: "static" | "supabase";
  exchanges?: Exchange[];
  url?: string;
  anon_key?: string;
  trunk_directory?: string;
}

/** Where the config lives: site root when the terminal is exported under
 *  /terminal/, overridable at build time. */
const PHONEBOOK_URL = process.env.NEXT_PUBLIC_PHONEBOOK_URL ?? "../phonebook.json";

/** Entry gate (exported for tests). Beyond shape, endpoints are scheme-checked
 *  the same way the observer surfaces vet `?api=`/`?link=` overrides and the
 *  Supabase schema CHECKs its rows (0002_exchanges.sql): api must be https:,
 *  link must be wss:. A hostile trunk registrant or malformed directory
 *  response must not be able to make the terminal dial a downgraded
 *  http:/ws: endpoint. */
export function valid(list: unknown): Exchange[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (e): e is Exchange =>
      !!e && typeof e.name === "string" && typeof e.region === "string" &&
      typeof e.api === "string" && e.api.startsWith("https://") &&
      typeof e.link === "string" && e.link.startsWith("wss://"),
  );
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

/** Merge live trunk entries in behind the book's own entries, deduped by
 *  `id` — a static/supabase entry always wins over a same-id trunk entry. */
function dedupe(primary: Exchange[], extra: Exchange[]): Exchange[] {
  const ids = new Set(primary.map((e) => e.id));
  return [...primary, ...extra.filter((e) => !ids.has(e.id))];
}

export async function loadExchanges(): Promise<Exchange[] | null> {
  try {
    const res = await fetch(PHONEBOOK_URL, { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = (await res.json()) as PhonebookConfig;
    if (cfg.source === "supabase" && cfg.url && cfg.anon_key) {
      const q = `${cfg.url}/rest/v1/exchanges` +
        `?select=id,name,region,api,link,joshua,operator&order=created_at`;
      // No data dependency between the book rows and the live trunk merge —
      // fetch both at once. trunkEntries degrades to [] on its own failures,
      // so only the PostgREST leg decides success vs null, same as before.
      const [r, trunk] = await Promise.all([
        fetch(q, {
          headers: { apikey: cfg.anon_key, authorization: `Bearer ${cfg.anon_key}` },
          cache: "no-store",
        }),
        trunkEntries(cfg.trunk_directory),
      ]);
      if (!r.ok) return null;
      return dedupe(valid(await r.json()), trunk);
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
