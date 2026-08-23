import { describe, it, expect } from 'bun:test'
import {
  EXPORT_COLUMNS,
  filterColumns,
  defaultSelection,
} from 'ui-shared/composables/useExportColumns'

// FR-02: compact (list) exports start with Status/Currency unticked and Payment Method
// ticked; the detailed (print) flow keeps its previous defaults.
describe('export column defaults (FR-02)', () => {
  it('compact defaults exclude status and currency', () => {
    const sel = defaultSelection('compact', 'invoice')
    expect(sel).not.toContain('status')
    expect(sel).not.toContain('currency')
  })

  it('compact defaults include paymentMethod for every doc type that offers it', () => {
    for (const doc of ['invoice', 'bill', 'cash_sale'] as const) {
      expect(defaultSelection('compact', doc)).toContain('paymentMethod')
    }
  })

  it('detailed defaults still include status and currency (print flow unchanged)', () => {
    const sel = defaultSelection('detailed', 'invoice')
    expect(sel).toContain('status')
    expect(sel).toContain('currency')
  })

  it('other compact defaults are unchanged', () => {
    const sel = defaultSelection('compact', 'invoice')
    for (const key of ['number', 'issueDate', 'dueDate', 'contactName', 'subtotal', 'taxTotal', 'total']) {
      expect(sel).toContain(key)
    }
    for (const key of ['contactTaxId', 'amountPaid', 'amountDue', 'reference']) {
      expect(sel).not.toContain(key)
    }
  })

  it('defaultSelection only ever returns columns valid for the mode/docType', () => {
    for (const mode of ['compact', 'detailed'] as const) {
      const valid = new Set(filterColumns(mode, 'bill').map(c => c.key))
      for (const key of defaultSelection(mode, 'bill')) expect(valid.has(key)).toBe(true)
    }
  })

  it('defaultOnByMode only overrides the modes it names', () => {
    for (const col of EXPORT_COLUMNS) {
      if (!col.defaultOnByMode) continue
      for (const mode of col.modes) {
        const expected = col.defaultOnByMode[mode] ?? col.defaultOn
        const sel = defaultSelection(mode, 'invoice')
        // dueDate-style doc restrictions don't apply to the overridden columns today,
        // but guard anyway: only assert when the column is offered for this docType.
        if (!col.docs || col.docs.includes('invoice')) {
          expect(sel.includes(col.key)).toBe(expected)
        }
      }
    }
  })
})
