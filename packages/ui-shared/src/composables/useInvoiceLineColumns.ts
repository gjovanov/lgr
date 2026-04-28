import { ref, computed, watch, type Ref } from 'vue'

/**
 * Invoice line-items column catalog + per (user × org × doc-type) localStorage persistence.
 * Mirrors useGRColumns from inventory-ui in shape, scoped to invoice editor grids.
 *
 * The composable is pure: caller passes user/org IDs (typically from its own app store).
 */

export type InvoiceDocType =
  | 'invoice'
  | 'proforma'
  | 'credit_note'
  | 'debit_note'
  | 'purchase_invoice'
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

export const INVOICE_LINE_COLUMNS: LineColumn[] = [
  { key: 'description', i18n: 'common.description',  defaultOn: true },
  { key: 'qty',         i18n: 'invoicing.qty',       defaultOn: true,  align: 'end',  width: '80px' },
  // unit currently only wired on InvoiceFormView's Line type
  { key: 'unit',        i18n: 'invoicing.unit',      defaultOn: true,                  width: '80px',
    docs: ['invoice'] },
  { key: 'unitPrice',   i18n: 'invoicing.unitPrice', defaultOn: true,  align: 'end',  width: '160px' },
  // discount only wired on Invoice + Proforma Line types
  { key: 'discount',    i18n: 'invoicing.discount',  defaultOn: false, align: 'end',  width: '70px',
    docs: ['invoice', 'proforma'] },
  { key: 'taxRate',     i18n: 'invoicing.taxRate',   defaultOn: true,  align: 'end',  width: '90px' },
  { key: 'warehouse',   i18n: 'warehouse.warehouse', defaultOn: true,                  width: '180px' },
  { key: 'lineTotal',   i18n: 'common.total',        defaultOn: true,  align: 'end',  width: '100px' },
]

export interface UseInvoiceLineColumnsOpts {
  /** Reactive user id (may change on login/logout). Falls back to 'anon'. */
  userId?: Ref<string | undefined> | (() => string | undefined)
  /** Reactive org id. Falls back to 'no-org'. */
  orgId?: Ref<string | undefined> | (() => string | undefined)
}

function unwrap(v: Ref<string | undefined> | (() => string | undefined) | undefined): string | undefined {
  if (!v) return undefined
  return typeof v === 'function' ? v() : v.value
}

export function useInvoiceLineColumns(
  docType: InvoiceDocType,
  opts: UseInvoiceLineColumnsOpts = {},
) {
  const availableColumns = computed<LineColumn[]>(() =>
    INVOICE_LINE_COLUMNS.filter(c => !c.docs || c.docs.includes(docType)),
  )

  const defaultSelection = computed<string[]>(() =>
    availableColumns.value.filter(c => c.defaultOn).map(c => c.key),
  )

  const storageKey = computed(() => {
    const u = unwrap(opts.userId) || 'anon'
    const o = unwrap(opts.orgId) || 'no-org'
    return `lgr:invoice-line-cols:${u}:${o}:${docType}`
  })

  const selected = ref<string[]>([])

  function load() {
    try {
      const raw = localStorage.getItem(storageKey.value)
      if (raw) {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr) && arr.every(s => typeof s === 'string')) {
          // Drop keys no longer in the catalog (forward-compat).
          const valid = arr.filter(k => availableColumns.value.some(c => c.key === k))
          // Always include 'description' (anchor column; cannot be hidden).
          if (!valid.includes('description')) valid.unshift('description')
          selected.value = valid
          return
        }
      }
    } catch {
      /* corrupt JSON — fall through */
    }
    selected.value = [...defaultSelection.value]
  }

  function save() {
    try {
      localStorage.setItem(storageKey.value, JSON.stringify(selected.value))
    } catch {
      /* quota / private-browsing — ignore */
    }
  }

  watch(selected, save, { deep: true })
  watch(storageKey, load, { immediate: true })

  const activeColumns = computed<LineColumn[]>(() =>
    availableColumns.value.filter(c => selected.value.includes(c.key)),
  )

  function toggle(key: string) {
    if (key === 'description') return // anchor column, always on
    const next = new Set(selected.value)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selected.value = availableColumns.value.filter(c => next.has(c.key)).map(c => c.key)
  }

  function selectAll() {
    selected.value = availableColumns.value.map(c => c.key)
  }

  function selectNone() {
    // Keep description anchor column.
    selected.value = ['description']
  }

  function resetDefaults() {
    selected.value = [...defaultSelection.value]
  }

  return {
    selected,
    availableColumns,
    activeColumns,
    toggle,
    selectAll,
    selectNone,
    resetDefaults,
  }
}
