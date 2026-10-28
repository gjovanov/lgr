/**
 * The last querystring each FR-05 list had, remembered per browser tab, so a list reached
 * WITHOUT a query (the form's Back button, the redirect after Save, the top menu, a
 * breadcrumb) comes back filtered, paged and sorted exactly as the user left it.
 *
 * Import-pure (no Vue, no router, no window) so the rules are unit-testable; the wiring
 * lives in `useListQueryState`.
 *
 * Rules:
 *  - The URL stays the source of truth. A list opened WITH any query param uses the URL and
 *    nothing remembered; only a completely bare URL is a candidate for recall.
 *  - Only an in-app navigation recalls (vue-router's `history.state.back` is set). A fresh
 *    page load, a typed or pasted bare URL, or a link from another app opens the defaults.
 *  - Per tab (`sessionStorage`, never `localStorage`) and keyed by org + user, so a
 *    remembered filter never follows the tab into another org or to another person.
 */

/** The parts of `Storage` used here, so tests can pass a plain object. */
export interface QueryMemoryStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type StoredQuery = Record<string, string>

export const LIST_QUERY_MEMORY_PREFIX = 'lgr:list-query:'

/** `scope` names the org + user; `routeKey` names the list. Empty scope = do not remember. */
export function listMemoryKey(scope: string, routeKey: string): string | null {
  if (!scope || !routeKey) return null
  return `${LIST_QUERY_MEMORY_PREFIX}${scope}:${routeKey}`
}

/** Keeps only plain string params (a repeated vue-router param is an array: first value wins). */
export function normalizeQuery(query: Record<string, unknown> | null | undefined): StoredQuery {
  const out: StoredQuery = {}
  if (!query || typeof query !== 'object') return out
  for (const [k, v] of Object.entries(query)) {
    const s = Array.isArray(v) ? v[0] : v
    if (typeof s === 'string' && s !== '') out[k] = s
  }
  return out
}

export function rememberListQuery(store: QueryMemoryStore | null, key: string | null, query: Record<string, unknown>): void {
  if (!store || !key) return
  try {
    store.setItem(key, JSON.stringify(normalizeQuery(query)))
  } catch { /* quota / blocked storage — remembering is a convenience */ }
}

export function recallListQuery(store: QueryMemoryStore | null, key: string | null): StoredQuery | null {
  if (!store || !key) return null
  try {
    const raw = store.getItem(key)
    if (!raw) return null
    const q = normalizeQuery(JSON.parse(raw))
    return Object.keys(q).length ? q : null
  } catch {
    return null
  }
}

/**
 * Replaces `owned` keys of the remembered query with `serialized`, keeping every other key —
 * a view runs several `useListQueryState` instances (filters + pagination) over one URL.
 */
export function mergeOwnedIntoStored(stored: StoredQuery | null, owned: Iterable<string>, serialized: StoredQuery): StoredQuery {
  const out: StoredQuery = { ...(stored || {}) }
  for (const k of owned) delete out[k]
  return { ...out, ...serialized }
}

/** Recall only on a bare URL reached by an in-app navigation. */
export function shouldRecallListQuery(query: Record<string, unknown> | null | undefined, historyState: unknown): boolean {
  if (query && Object.keys(query).length > 0) return false
  const back = (historyState as { back?: unknown } | null | undefined)?.back
  return typeof back === 'string' && back.length > 0
}
