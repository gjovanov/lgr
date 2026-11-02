import { describe, it, expect } from 'bun:test'
import { canPickPart, canStornoTransaction, canStornoJournalRow, STORNO_ROLES } from '../../../invoicing-ui/src/pos/composables/storno'

/**
 * #145 — the STORNO button must never be offered where the server would refuse it
 * (`POST /session/:id/storno`: admin / manager / warehouse_manager, a completed non-storno sale).
 */
describe('canPickPart: what the storno dialog offers beside all of it (the reader, finding 7)', () => {
  it('a single line of one unit or less: 0.8 kg can go back 0.3, and one unit may be sold by the kilo', () => {
    expect(canPickPart([{ left: 0.8 }])).toBe(true)
    expect(canPickPart([{ left: 1 }])).toBe(true)
    expect(canPickPart([{ left: 0.002 }])).toBe(true)
  })

  it('more than one unit, or more than one line with anything left', () => {
    expect(canPickPart([{ left: 3 }])).toBe(true)
    expect(canPickPart([{ left: 1 }, { left: 1 }])).toBe(true)
    expect(canPickPart([{ left: 0 }, { left: 0.5 }])).toBe(true)
  })

  it('not with nothing left, nor on the smallest quantity a device prints: all of it is the only part there is', () => {
    expect(canPickPart([])).toBe(false)
    expect(canPickPart([{ left: 0 }, { left: 0 }])).toBe(false)
    expect(canPickPart([{ left: 0.001 }])).toBe(false)
  })
})

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
    // FR-23: a fiscal receipt nothing can prove: a person settles it first, and the server refuses until then.
    expect(canStornoTransaction({ type: 'sale', status: 'completed', isFiscal: true, fiscal: { state: 'unknown' } }, 'admin')).toBe(false)
    expect(canStornoTransaction({ type: 'sale', status: 'completed', isFiscal: false, fiscal: { state: 'unknown' } }, 'admin')).toBe(true)
    expect(canStornoJournalRow({ kind: 'sale', status: 'inDoubt', origin: 'pos' }, 'admin')).toBe(false)
  })

  it('FR-23 R3: what is left of a partly stornoed sale can go back too, but not once it is invoiced or all back', () => {
    expect(canStornoJournalRow({ kind: 'sale', status: 'partial', origin: 'pos' }, 'admin')).toBe(true)
    expect(canStornoJournalRow({ kind: 'sale', status: 'partial', origin: 'backoffice' }, 'manager')).toBe(true)
    expect(canStornoJournalRow({ kind: 'sale', status: 'partial', origin: 'pos', invoicingState: 'full' }, 'admin')).toBe(false)
    expect(canStornoJournalRow({ kind: 'sale', status: 'stornoed', origin: 'pos' }, 'admin')).toBe(false)
    expect(canStornoJournalRow({ kind: 'sale', status: 'partial', origin: 'import' }, 'admin')).toBe(false)
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
