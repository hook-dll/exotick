/**
 * Parse a server-side timestamp. SQLite's CURRENT_TIMESTAMP emits UTC as
 * "YYYY-MM-DD HH:MM:SS" with no timezone marker; browsers and Node
 * default to LOCAL interpretation for that format, which silently offsets
 * every "how long ago was this" calculation by the server's timezone.
 *
 * This helper normalizes to a canonical ISO-with-Z string before parsing
 * so the resulting Date represents the true moment. Use it anywhere the
 * result feeds into an elapsed-time computation. For pure display (e.g.
 * `.toLocaleString()`) the offset is less critical but still safer to
 * route through here.
 */
export function parseServerTs(s: string | null | undefined): number {
  if (!s) return NaN;
  // Already ISO with T + Z (or a numeric offset) — trust it.
  const looksIso = /T/.test(s) && /(Z|[+-]\d{2}:?\d{2})$/.test(s);
  const normalized = looksIso ? s : s.replace(' ', 'T') + 'Z';
  const t = new Date(normalized).getTime();
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Format a server timestamp for display in the VIEWER's local timezone.
 * Parses via parseServerTs (so the UTC instant is read correctly) and returns
 * `toLocaleString()`; empty string for missing/invalid input so callers can
 * fall back with `|| '—'`.
 */
export function formatServerTs(s: string | null | undefined): string {
  const t = parseServerTs(s);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : '';
}
