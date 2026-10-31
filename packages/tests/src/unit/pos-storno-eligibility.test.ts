import { describe, it, expect } from 'bun:test'
import { canStornoTransaction, canStornoJournalRow, STORNO_ROLES } from '../../../invoicing-ui/src/pos/composables/storno'

/**
 * #145 — the STORNO button must never be offered where the server would refuse it
 * (`POST /session/:id/storno`: admin / manager / warehouse_manager, a completed non-storno sale).
 */
describe('canStornoTransaction', () => {
  it('offers storno on a completed sale to the roles the server accepts', () => {
    for (const role of STORNO_ROLES) {
      expect(canStornoTransaction({ type: 'sale', status: 'completed' }, role), role).toBe(true)
    }
  })

  it('never to a cashier or a read-only role', () => {
    for (const role of ['member', 'accountant', 'nra_auditor', 'cashier', '', undefined]) {
      expect(canStornoTransaction({ type: 'sale', status: 'completed' }, role as any), String(role)).toBe(false)
    }
  })

  it('never on a storno, a cancelled (already reversed) sale, or nothing', () => {
    expect(canStornoTransaction({ type: 'storno', status: 'completed' }, 'admin')).toBe(false)
    expect(canStornoTransaction({ type: 'sale', status: 'cancelled' }, 'admin')).toBe(false)
    expect(canStornoTransaction(null, 'admin')).toBe(false)
  })
})

describe('canStornoJournalRow (FR-21 §3.5)', () => {
  const row = (over: Record<string, unknown> = {}) => ({ kind: 'sale', status: 'completed', origin: 'pos', store: 'invoice', invoicingState: 'none', ...over })

  it('a till sale or a back-office sale, from either store', () => {
    for (const r of [row(), row({ store: 'pos', invoicingState: undefined }), row({ origin: 'backoffice' })]) {
      expect(canStornoJournalRow(r, 'manager'), JSON.stringify(r)).toBe(true)
    }
  })

  it('not an imported day, an invoiced sale, a storno, a stornoed sale, or for a cashier', () => {
    expect(canStornoJournalRow(row({ origin: 'import' }), 'admin')).toBe(false)
    expect(canStornoJournalRow(row({ invoicingState: 'partial' }), 'admin')).toBe(false)
    expect(canStornoJournalRow(row({ kind: 'storno' }), 'admin')).toBe(false)
    expect(canStornoJournalRow(row({ status: 'stornoed' }), 'admin')).toBe(false)
    expect(canStornoJournalRow(row(), 'sales')).toBe(false)
  })
})
