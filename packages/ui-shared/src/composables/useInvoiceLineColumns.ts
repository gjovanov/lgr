import { ref, computed, watch, type Ref } from 'vue'

/**
 * Invoice line-items column catalog + per (user × org × doc-type) preferences:
 * visibility AND order (reorderable, like the list-grid picker useGridColumns).
 *
 * Storage `lgr:invoice-line-cols:<user>:<org>:<docType>` → { order: string[], hidden: string[] }.
 * Backward-compat: an older plain string[] (the visible set, catalog order) is migrated
 * to {order, hidden} on load. `description` is the anchor column — never hidden, never moved.
 */

export type InvoiceDocType =
  | 'invoice'
  | 'proforma'
  | 'credit_note'
  | 'debit_note'
  | 'purchase_invoice'
  | 'purchase_credit_note'
  | 'purchase_debit_note'
  | 'cash_sale'

export interface LineColumn {
  key: string
  i18n: string
  align?: 'start' | 'end'
  /** CSS width for <th>/<td>. */
  width?: string
  defaultOn: boolean
  /** Restrict the column to specific doc types; omit = all. */
  docs?: InvoiceDocType[]
}

export interface LineColumnEntry {
  key: string
  i18n: string
  visible: boolean
  locked: boolean
}

// Widths are as narrow as each column's content allows (the cells carry 6px gutters): the
// description column takes whatever is left, so every pixel saved here shows more of the row.
export const INVOICE_LINE_COLUMNS: LineColumn[] = [
  { key: 'description', i18n: 'common.description',  defaultOn: true },
  { key: 'qty',         i18n: 'invoicing.qty',       defaultOn: true,  align: 'end',  width: '84px' },
  { key: 'unit',        i18n: 'invoicing.unit',      defaultOn: true,                  width: '84px' },
  // the price picker icon + a combobox that always shows 5 decimals ("19.60000")
  { key: 'unitPrice',   i18n: 'invoicing.unitPrice', defaultOn: true,  align: 'end',  width: '168px' },
  // discount only wired on Invoice + Proforma Line types
  { key: 'discount',    i18n: 'invoicing.discount',  defaultOn: false, align: 'end',  width: '72px',
    docs: ['invoice', 'proforma'] },
  { key: 'taxRate',     i18n: 'invoicing.taxRate',   defaultOn: false, align: 'end',  width: '100px' },
  { key: 'warehouse',   i18n: 'warehouse.warehouse', defaultOn: false,                 width: '150px' },
  // net line amount (qty × unit price, less the line discount) — the default money column,
  // positioned right before the gross Total so enabling Total puts the pair side-by-side.
  { key: 'lineSubtotal', i18n: 'invoicing.subtotal', defaultOn: true,  align: 'end',  width: '100px' },
  { key: 'lineTotal',   i18n: 'common.total',        defaultOn: false, align: 'end',  width: '100px' },
]

const ANCHOR = 'description'

export interface UseInvoiceLineColumnsOpts {
  userId?: Ref<string | undefined> | (() => string | undefined)
  orgId?: Ref<string | undefined> | (() => string | undefined)
}

function unwrap(v: Ref<string | undefined> | (() => string | undefined) | undefined): string | undefined {
  if (!v) return undefined
  return typeof v === 'function' ? v() : v.value
}

interface Pref { order: string[]; hidden: string[] }

export function useInvoiceLineColumns(
  docType: InvoiceDocType,
  opts: UseInvoiceLineColumnsOpts = {},
) {
  const availableColumns = computed<LineColumn[]>(() =>
    INVOICE_LINE_COLUMNS.filter(c => !c.docs || c.docs.includes(docType)),
  )
  const catalogKeys = computed(() => availableColumns.value.map(c => c.key))
  const defaultVisible = computed<string[]>(() => availableColumns.value.filter(c => c.defaultOn).map(c => c.key))

  const storageKey = computed(() => {
    const u = unwrap(opts.userId) || 'anon'
    const o = unwrap(opts.orgId) || 'no-org'
    return `lgr:invoice-line-cols:${u}:${o}:${docType}`
  })

  // Pristine (never-saved) preference: hide the non-default columns, keep catalog order.
  function defaultPref(): Pref {
    return { order: [], hidden: catalogKeys.value.filter(k => k !== ANCHOR && !availableColumns.value.find(c => c.key === k)!.defaultOn) }
  }

  const pref = ref<Pref>(defaultPref())

  /** Where preferences went before the user id was known: still read when the user has none. */
  const legacyKey = () => `lgr:invoice-line-cols:anon:${unwrap(opts.orgId) || 'no-org'}:${docType}`

  function load() {
    try {
      const raw = localStorage.getItem(storageKey.value) ?? localStorage.getItem(legacyKey())
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        // Legacy format: visible keys in catalog order → derive {order, hidden}.
        const visible = parsed.filter((k: any) => typeof k === 'string' && catalogKeys.value.includes(k))
        pref.value = { order: visible, hidden: catalogKeys.value.filter(k => !visible.includes(k) && k !== ANCHOR) }
      } else if (parsed && typeof parsed === 'object') {
        pref.value = {
          order: Array.isArray(parsed.order) ? parsed.order.filter((k: any) => typeof k === 'string') : [],
          hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((k: any) => typeof k === 'string') : [],
        }
      } else {
        pref.value = defaultPref()
      }
    } catch {
      pref.value = defaultPref()
    }
  }

  function save() {
    try {
      localStorage.setItem(storageKey.value, JSON.stringify(pref.value))
    } catch {
      /* quota / private-browsing */
    }
  }

  watch(storageKey, load, { immediate: true })

  /** All catalog keys in the user's order (saved order first, new catalog keys spliced in place). */
  const orderedKeys = computed<string[]>(() => {
    const catalog = catalogKeys.value
    const saved = pref.value.order.filter(k => catalog.includes(k))
    const out = [...saved]
    for (const k of catalog) {
      if (out.includes(k)) continue
      const catIdx = catalog.indexOf(k)
      let at = out.length
      for (let i = 0; i < out.length; i++) { if (catalog.indexOf(out[i]) > catIdx) { at = i; break } }
      out.splice(at, 0, k)
    }
    // Anchor is always first.
    return [ANCHOR, ...out.filter(k => k !== ANCHOR)]
  })

  const hiddenSet = computed(() => new Set(pref.value.hidden.filter(k => k !== ANCHOR)))

  /** Visible keys in order (drives isColActive + the "N selected" count). */
  const selected = computed<string[]>(() => orderedKeys.value.filter(k => !hiddenSet.value.has(k)))

  /** Visible column defs in order (drives thead/tbody rendering). */
  const activeColumns = computed<LineColumn[]>(() => {
    const byKey = new Map(availableColumns.value.map(c => [c.key, c]))
    return selected.value.map(k => byKey.get(k)).filter(Boolean) as LineColumn[]
  })

  /** All columns in order with visible/locked flags (drives the reorderable picker). */
  const entries = computed<LineColumnEntry[]>(() =>
    orderedKeys.value.map(k => {
      const c = availableColumns.value.find(x => x.key === k)!
      return { key: k, i18n: c.i18n, visible: !hiddenSet.value.has(k), locked: k === ANCHOR }
    }),
  )

  function toggle(key: string) {
    if (key === ANCHOR) return
    const hidden = new Set(pref.value.hidden)
    if (hidden.has(key)) hidden.delete(key)
    else hidden.add(key)
    pref.value = { order: orderedKeys.value, hidden: [...hidden] }
    save()
  }

  function move(key: string, dir: -1 | 1) {
    if (key === ANCHOR) return
    const order = orderedKeys.value.filter(k => k !== ANCHOR)
    const idx = order.indexOf(key)
    const to = idx + dir
    if (idx === -1 || to < 0 || to >= order.length) return
    order.splice(idx, 1)
    order.splice(to, 0, key)
    pref.value = { order: [ANCHOR, ...order], hidden: pref.value.hidden }
    save()
  }

  /** FR-05 (#12): drag & drop reorder. The anchor stays pinned first regardless of input. */
  function reorder(keys: string[]) {
    const known = new Set(orderedKeys.value)
    const order = keys.filter(k => known.has(k) && k !== ANCHOR)
    for (const k of orderedKeys.value) if (k !== ANCHOR && !order.includes(k)) order.push(k)
    pref.value = { order: [ANCHOR, ...order], hidden: pref.value.hidden }
    save()
  }

  function selectAll() {
    pref.value = { order: orderedKeys.value, hidden: [] }
    save()
  }

  function selectNone() {
    pref.value = { order: orderedKeys.value, hidden: catalogKeys.value.filter(k => k !== ANCHOR) }
    save()
  }

  function resetDefaults() {
    try {
      localStorage.removeItem(storageKey.value)
      // `load()` falls back to the legacy key: leave it behind and the old columns come back on
      // the next load, so a reset would not stick.
      localStorage.removeItem(legacyKey())
    } catch { /* */ }
    pref.value = defaultPref()
  }

  return {
    selected,
    availableColumns,
    activeColumns,
    entries,
    toggle,
    move,
    reorder,
    selectAll,
    selectNone,
    resetDefaults,
  }
}
