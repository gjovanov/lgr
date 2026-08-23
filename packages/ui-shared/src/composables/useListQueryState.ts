import { watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * FR-05 (#12): reflect list/grid state (search, filters, page, size, sort, view mode) in
 * the querystring so Back restores the exact grid and URLs are shareable.
 *
 * Contract:
 *  - HYDRATES synchronously at setup: refs receive the URL's values before the view's
 *    first fetch. Absent params leave the ref untouched (its default).
 *  - WRITES via router.replace (never push — Back must leave the list, not step through
 *    filter history), debounced, MERGING: only the declared keys are touched; every
 *    foreign param (?restore=…, future ones) is preserved verbatim.
 *  - Params equal to their default are omitted (clean URLs).
 *  - Reacts to external query changes (Back/Forward between two filter states of the
 *    same list) by re-hydrating; self-writes are ignored via serialization comparison.
 *
 * Ordering matters in consumers: declare filter refs (and hydrate them) BEFORE creating
 * usePaginatedTable, so its deep filters-watcher registers against the already-hydrated
 * values and does not fire a spurious page reset + second fetch on mount.
 */

export type QueryCodec = 'string' | 'int' | 'csv' | 'date' | 'bool'

export interface QueryParamDef {
  /** URL param name (conventions: q, status, type, from, to, tags, page, size, sortBy, sortOrder, view). */
  key: string
  ref: Ref<any>
  codec?: QueryCodec
  /** Omitted from the URL when the serialized value equals the serialized default. */
  default?: any
  /** Hydration also sets this ref (e.g. debouncedSearch alongside search — one fetch, not two). */
  mirror?: Ref<any>
  /** Post-parse validation; return undefined to reject the URL value (default kept). */
  sanitize?: (v: any) => any
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Exported for unit tests — the wire contract every synced view relies on. */
export function serializeQueryValue(value: any, codec: QueryCodec): string | undefined {
  return serialize(value, codec)
}
export function parseQueryValue(raw: string, codec: QueryCodec): any {
  return parse(raw, codec)
}

function serialize(value: any, codec: QueryCodec): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  switch (codec) {
    case 'csv':
      return Array.isArray(value) && value.length ? value.join(',') : undefined
    case 'int':
      return Number.isFinite(Number(value)) ? String(value) : undefined
    case 'bool':
      return value ? 'true' : undefined
    case 'date':
      return DATE_RE.test(String(value)) ? String(value) : undefined
    default:
      return String(value)
  }
}

function parse(raw: string, codec: QueryCodec): any {
  switch (codec) {
    case 'csv':
      return raw.split(',').map(s => s.trim()).filter(Boolean)
    case 'int': {
      const n = Number(raw)
      return Number.isFinite(n) ? n : undefined
    }
    case 'bool':
      return raw === 'true' || raw === '1'
    case 'date':
      return DATE_RE.test(raw) ? raw : undefined
    default:
      return raw
  }
}

export function useListQueryState(defs: QueryParamDef[], opts: { debounceMs?: number } = {}) {
  const route = useRoute()
  const router = useRouter()
  const debounceMs = opts.debounceMs ?? 250
  const owned = new Set(defs.map(d => d.key))

  /** The serialized owned-subset of a query object — the loop-guard fingerprint. */
  function fingerprintOf(query: Record<string, any>): string {
    return defs
      .map(d => `${d.key}=${query[d.key] ?? ''}`)
      .join('&')
  }

  function currentSerialized(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const d of defs) {
      const codec = d.codec || 'string'
      const s = serialize(d.ref.value, codec)
      const defS = serialize(d.default, codec)
      if (s !== undefined && s !== defS) out[d.key] = s
    }
    return out
  }

  function applyFromQuery(query: Record<string, any>) {
    for (const d of defs) {
      const raw = query[d.key]
      if (raw === undefined || raw === null) continue
      const codec = d.codec || 'string'
      let value = parse(String(raw), codec)
      if (value === undefined) continue
      if (d.sanitize) {
        value = d.sanitize(value)
        if (value === undefined) continue
      }
      d.ref.value = value
      if (d.mirror) d.mirror.value = value
    }
  }

  // ── hydrate (synchronous, before the consumer's first fetch) ──
  applyFromQuery(route.query as Record<string, any>)

  // ── state → URL (debounced replace, merge-preserving foreign params) ──
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastWritten = fingerprintOf({ ...route.query, ...currentSerialized() })

  function write() {
    const next: Record<string, any> = {}
    for (const [k, v] of Object.entries(route.query)) {
      if (!owned.has(k)) next[k] = v
    }
    Object.assign(next, currentSerialized())
    const fp = fingerprintOf(next)
    if (fp === fingerprintOf(route.query as Record<string, any>)) return
    lastWritten = fp
    router.replace({ query: next }).catch(() => { /* duplicate navigation — fine */ })
  }

  watch(
    defs.map(d => d.ref),
    () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(write, debounceMs)
    },
    { deep: true },
  )

  // ── URL → state (Back/Forward between filter states of the SAME route) ──
  watch(
    () => route.query,
    (q) => {
      const fp = fingerprintOf(q as Record<string, any>)
      if (fp === lastWritten) return
      lastWritten = fp
      applyFromQuery(q as Record<string, any>)
    },
  )

  return {
    /** Flush a pending debounced write immediately (e.g. before programmatic navigation). */
    flush: () => {
      if (timer) clearTimeout(timer)
      write()
    },
  }
}

/**
 * The pagination half of the sync, for `usePaginatedTable({ urlSync: true })`: page is
 * 1-based in the URL (humans), 0-based internally.
 */
export const ALLOWED_PAGE_SIZES = [10, 25, 50, 100, -1]
