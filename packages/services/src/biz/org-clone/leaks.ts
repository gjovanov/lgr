/**
 * Does a copy still name its real org? The second opinion on `remap.ts`.
 *
 * ⚠ IMPORT-PURE, and it deliberately shares nothing with the rewrite. The rewrite replaces an id that is
 * a whole 24-hex token; this looks at EVERY 24-character window of hex digits in a document's text, so an
 * id glued to other hex digits (`<orgId><docId>` kept as one key, a prefix written straight before an id)
 * is found too. A check that used the rewrite's own rule would share the rewrite's blind spots, which is
 * the one thing a check must not do. It is stricter on purpose: a hit it makes that the rewrite never
 * would is a real reference the rewrite does not know how to follow, which is exactly what is worth finding.
 */

/** A zero-width match at every position where 24 hex digits begin, so the windows overlap. */
const WINDOW = /(?=([0-9a-f]{24}))/g

/** The ids of `ids` that `text` names anywhere in it (case-insensitive, every window), each once. `ids` holds lowercase hex. */
export function namedIds(text: string, ids: ReadonlySet<string>): string[] {
  const found = new Set<string>()
  for (const m of text.toLowerCase().matchAll(WINDOW)) {
    const digits = m[1]!
    if (ids.has(digits)) found.add(digits)
  }
  return [...found]
}
