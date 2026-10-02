/**
 * "Did the till already sell this invoice?"
 *
 * regal-sf's first day in LGR had three invoices whose every line the day's till export already
 * carried — 17 lines, all dispatched twice, two products driven negative. This is the detector for
 * that, and it WARNS rather than suppressing: containment is not proof, and the only reliable
 * arbiter is the next stock snapshot. The tests below pin both halves of that — what it must catch,
 * and what it must refuse to call.
 */
import { describe, it, expect } from 'bun:test'
import { findTillOverlap, tillOverlapWarning, type TillDay } from 'services/biz/doc-import/till-overlap'
import type { MappedInvoice } from 'services/biz/doc-import/types'

const till = (pairs: Array<[string, number]>): TillDay => ({
  demand: new Map(pairs),
  docNumber: 'CS-2026-00001',
  reference: 'salesAnalysis:2026-10-01',
})

const invoice = (lines: Array<{ productId?: string; quantity: number }>, over: Partial<MappedInvoice> = {}): MappedInvoice => ({
  type: 'invoice',
  direction: 'outgoing',
  issueDate: '2026-10-01',
  dueDate: '2026-10-01',
  currency: 'EUR',
  lines: lines.map(l => ({
    productId: l.productId,
    description: 'x',
    quantity: l.quantity,
    unit: 'pcs',
    unitPrice: 1,
    discount: 0,
    taxRate: 20,
    taxAmount: 0,
    lineTotal: l.quantity,
  })),
  subtotal: 0,
  taxTotal: 0,
  total: 0,
  ...over,
} as MappedInvoice)

describe('an invoice the till already rang', () => {
  it('is reported, with the line and unit counts', () => {
    // INV-2000128367 in miniature: ten lines, every one inside the till.
    const hit = findTillOverlap(
      invoice([{ productId: 'a', quantity: 6 }, { productId: 'b', quantity: 24 }]),
      till([['a', 6], ['b', 34]]),
    )
    expect(hit).toEqual({ reference: 'salesAnalysis:2026-10-01', docNumber: 'CS-2026-00001', lines: 2, quantity: 30 })
  })

  it('says what to do about it, in terms the review treats as blocking', () => {
    const msg = tillOverlapWarning({ reference: 'salesAnalysis:2026-10-01', docNumber: 'CS-2026-00001', lines: 2, quantity: 30 })
    expect(msg).toContain('VERIFY before committing')
    expect(msg).toContain('CS-2026-00001')
    expect(msg).toContain('second time')
  })

  it('names the day rather than a document when the till is not booked yet', () => {
    // The usual case: the whole day is uploaded at once, so the till export is still a file.
    const msg = tillOverlapWarning({ reference: 'salesAnalysis:2026-10-01', docNumber: null, lines: 1, quantity: 6 })
    expect(msg).toContain("the day's till export")
    expect(msg).toContain('salesAnalysis:2026-10-01')
  })
})

describe('what it must refuse to call', () => {
  it('refuses when ONE line is not covered', () => {
    // A single uncovered line means this is a different sale, whatever the rest looks like.
    expect(findTillOverlap(
      invoice([{ productId: 'a', quantity: 6 }, { productId: 'c', quantity: 1 }]),
      till([['a', 6]]),
    )).toBeNull()
  })

  it('refuses when a line asks for MORE than the till sold', () => {
    expect(findTillOverlap(invoice([{ productId: 'a', quantity: 7 }]), till([['a', 6]]))).toBeNull()
  })

  it('refuses when a line carries no product, because the two cannot be compared', () => {
    // Guessing here books a duplicate dispatch or hides a real one. Neither is acceptable.
    expect(findTillOverlap(
      invoice([{ productId: 'a', quantity: 6 }, { quantity: 1 }]),
      till([['a', 6]]),
    )).toBeNull()
  })

  it('refuses a document that is not an outgoing sales invoice', () => {
    const t = till([['a', 6]])
    for (const over of [{ type: 'cash_sale' }, { type: 'credit_note' }, { direction: 'incoming' }] as Array<Partial<MappedInvoice>>)
      expect(findTillOverlap(invoice([{ productId: 'a', quantity: 6 }], over), t)).toBeNull()
  })

  it('refuses when the day has no till at all', () => {
    expect(findTillOverlap(invoice([{ productId: 'a', quantity: 6 }]), till([]))).toBeNull()
  })

  it('refuses an invoice with nothing on it', () => {
    expect(findTillOverlap(invoice([]), till([['a', 6]]))).toBeNull()
    expect(findTillOverlap(invoice([{ productId: 'a', quantity: 0 }]), till([['a', 6]]))).toBeNull()
  })

  it('tolerates a hair of floating-point error, but not a real shortfall', () => {
    expect(findTillOverlap(invoice([{ productId: 'a', quantity: 6.0005 }]), till([['a', 6]]))).not.toBeNull()
    expect(findTillOverlap(invoice([{ productId: 'a', quantity: 6.1 }]), till([['a', 6]]))).toBeNull()
  })
})
