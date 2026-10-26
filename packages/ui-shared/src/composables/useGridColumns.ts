import { ref, computed, watch, type Ref, type ComputedRef } from 'vue'
import { jwtUserId, orgIdFromStorage } from './useStorageIdentity'

/**
 * Generic per-user column preferences (visibility + order) for list grids.
 *
 * Used by ListScaffold, so every list view gets the feature without per-view code.
 * The view keeps passing its full `headers` catalog; this composable projects it
 * through the user's saved preference:
 *   - hidden keys are dropped (the actions/expand columns are never hideable)
 *   - a column the view marks `defaultHidden` starts hidden until the user shows it (FR-22.23:
 *     a document list fits 1366 px, so a column that repeats what another shows — the currency
 *     of an amount printed with its currency — is offered on the cog rather than shown)
 *   - saved order wins; a catalog key the saved order has never seen (a column shipped
 *     later) goes right after the column that precedes it in the catalog, wherever the
 *     user put that one
 *
 * A saved order exists only once the user has MOVED a column (hiding saves none), so a
 * change of the default order reaches everyone who never reordered, and nobody else.
 *
 * Storage: `lgr:grid-cols:<userId>:<orgId>:<gridId>` → { order: string[], hidden: string[],
 * shown?: string[] } — `shown` holds the default-hidden columns the user turned on.
 * userId comes from this tab's session token (no app-store coupling here), orgId from the
 * session's org (`session/session.ts`).
 */

export interface GridColumnEntry {
  key: string
  title: string
  visible: boolean
  locked: boolean
}

const NEVER_HIDE = new Set(['actions', 'data-table-expand', 'data-table-select'])

interface GridColsPref {
  order: string[]
  hidden: string[]
  /** Default-hidden columns the user turned on. */
  shown: string[]
}

/**
 * The catalog's keys in a user's saved order. Keys the saved order lacks are placed right after
 * their catalog predecessor (the first catalog key leads); keys the catalog no longer has drop.
 * With nothing saved, that is the catalog order.
 *
 * Anchored on the predecessor, not the successor: when FR-22.46 moved „Наличност" before
 * „Мярка" and added „Резервирано" / „Поръчано" after it, a user whose saved order still read
 * Мярка, Наличност got the new columns BEFORE Мярка — away from the stock they qualify —
 * because Мярка was the first saved column the catalog now lists after them.
 */
export function orderColumnKeys(catalog: readonly string[], saved: readonly string[]): string[] {
  const out = [...new Set(saved)].filter((k) => catalog.includes(k))
  // Walking the catalog in order, a key's predecessor is always placed by the time the key is:
  // either it was saved, or it was inserted one step earlier.
  catalog.forEach((k, i) => {
    if (out.includes(k)) return
    out.splice(i === 0 ? 0 : out.indexOf(catalog[i - 1]) + 1, 0, k)
  })
  return out
}

export function useGridColumns(opts: {
  headers: Ref<any[]> | ComputedRef<any[]>
  /** Stable grid identity — typically the route name/path. */
  gridId: Ref<string> | ComputedRef<string> | (() => string)
}) {
  const gridId = typeof opts.gridId === 'function' ? computed(opts.gridId) : opts.gridId
  const storageKey = computed(() => `lgr:grid-cols:${jwtUserId()}:${orgIdFromStorage()}:${gridId.value || 'grid'}`)

  const pref = ref<GridColsPref>({ order: [], hidden: [], shown: [] })

  function load() {
    try {
      const raw = localStorage.getItem(storageKey.value)
      const parsed = raw ? JSON.parse(raw) : null
      pref.value = {
        order: Array.isArray(parsed?.order) ? parsed.order.filter((k: any) => typeof k === 'string') : [],
        hidden: Array.isArray(parsed?.hidden) ? parsed.hidden.filter((k: any) => typeof k === 'string') : [],
        shown: Array.isArray(parsed?.shown) ? parsed.shown.filter((k: any) => typeof k === 'string') : [],
      }
    } catch {
      pref.value = { order: [], hidden: [], shown: [] }
    }
  }

  function save() {
    try {
      if (!pref.value.order.length && !pref.value.hidden.length && !pref.value.shown.length) localStorage.removeItem(storageKey.value)
      else localStorage.setItem(storageKey.value, JSON.stringify(pref.value))
    } catch {
      /* quota / private browsing */
    }
  }

  watch(storageKey, load, { immediate: true })

  const keyed = computed(() => (opts.headers.value || []).filter((h: any) => h && typeof h.key === 'string'))

  /** Hidden: by the user, or by the view (`defaultHidden`) until the user shows it. */
  function isHidden(key: string): boolean {
    if (NEVER_HIDE.has(key)) return false
    if (pref.value.hidden.includes(key)) return true
    const h: any = keyed.value.find((x: any) => x.key === key)
    return !!h?.defaultHidden && !pref.value.shown.includes(key)
  }

  /** Catalog keys in the user's order (`orderColumnKeys`). */
  const orderedKeys = computed<string[]>(() => orderColumnKeys(keyed.value.map((h: any) => h.key), pref.value.order))

  const effectiveHeaders = computed(() => {
    const byKey = new Map(keyed.value.map((h: any) => [h.key, h]))
    const rows = orderedKeys.value
      .filter((k) => !isHidden(k))
      .map((k) => byKey.get(k))
      .filter(Boolean)
    // Headers without a key (rare) keep their original trailing position.
    const unkeyed = (opts.headers.value || []).filter((h: any) => !h || typeof h.key !== 'string')
    return [...rows, ...unkeyed]
  })

  const entries = computed<GridColumnEntry[]>(() =>
    orderedKeys.value.map((k) => {
      const h: any = keyed.value.find((x: any) => x.key === k)
      return {
        key: k,
        title: String(h?.title ?? k),
        visible: !isHidden(k),
        locked: NEVER_HIDE.has(k),
      }
    }),
  )

  function toggle(key: string) {
    if (NEVER_HIDE.has(key)) return
    const hidden = new Set(pref.value.hidden)
    const shown = new Set(pref.value.shown)
    if (isHidden(key)) {
      hidden.delete(key)
      if ((keyed.value.find((x: any) => x.key === key) as any)?.defaultHidden) shown.add(key)
    } else {
      hidden.add(key)
      shown.delete(key)
    }
    pref.value = { ...pref.value, hidden: [...hidden], shown: [...shown] }
    save()
  }

  function move(key: string, dir: -1 | 1) {
    const order = [...orderedKeys.value]
    const idx = order.indexOf(key)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= order.length) return
    order.splice(idx, 1)
    order.splice(to, 0, key)
    pref.value = { ...pref.value, order }
    save()
  }

  /** FR-05 (#12): drag & drop reorder — persist the full key order in one write. */
  function reorder(keys: string[]) {
    const known = new Set(orderedKeys.value)
    const order = keys.filter(k => known.has(k))
    // Anything the drag payload missed (race with a catalog change) keeps its position.
    for (const k of orderedKeys.value) if (!order.includes(k)) order.push(k)
    pref.value = { ...pref.value, order }
    save()
  }

  function reset() {
    pref.value = { order: [], hidden: [], shown: [] }
    save()
  }

  const customized = computed(() => pref.value.order.length > 0 || pref.value.hidden.length > 0 || pref.value.shown.length > 0)

  return { effectiveHeaders, entries, toggle, move, reorder, reset, customized }
}
