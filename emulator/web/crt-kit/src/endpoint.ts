// Shared by the three observer surfaces (norad-terminal, norad-bigboard,
// wopr-panel) — see docs/surfaces.md.

/** War Room `?api=&link=` overrides (https:/wss: only — no downgrade), so a
 *  trunk-dialed station can point at a different exchange than the build's
 *  own env vars without the operator retyping anything. */
export function endpointFromQuery(param: "api" | "link", fallback: string | undefined): string | undefined {
  if (typeof window === "undefined") return fallback;
  const v = new URLSearchParams(window.location.search).get(param);
  if (!v) return fallback;
  return /^(https:|wss:)/.test(v) ? v : fallback;
}
