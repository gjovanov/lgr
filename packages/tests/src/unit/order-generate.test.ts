import { describe, it, expect } from 'bun:test'
import { asDraftOrder, defaultDraftFor, pickDraftsFor } from '../../../invoicing-ui/src/composables/order-generate'

/**
 * FR-22.42 — where „Създай изходяща поръчка" puts a client order's short lines: a draft supplier
 * order the same supplier already has is offered, and chosen when it carries every supplier.
 */

const draft = (id: string, suppliers: string[], createdAt: string, lines = 1) => asDraftOrder({
  _id: id,
  orderNumber: `DRF-ORDO-2026-0000${id}`,
  supplierNames: suppliers.map((s) => s.toUpperCase()),
  createdAt,
  supplierGroups: suppliers.map((s) => ({ supplierId: s, lines: Array.from({ length: lines }, () => ({})) })),
})

const drafts = [
  draft('1', ['a'], '2026-10-20T08:00:00.000Z'),
  draft('2', ['a', 'b'], '2026-10-25T08:00:00.000Z', 2),
  draft('3', ['c'], '2026-10-26T08:00:00.000Z'),
]

describe('the drafts a generate is offered', () => {
  it('reads a draft from the orders list', () => {
    expect(drafts[1]).toEqual({
      _id: '2', orderNumber: 'DRF-ORDO-2026-00002', supplierIds: ['a', 'b'], supplierNames: ['A', 'B'], lineCount: 4,
      createdAt: '2026-10-25T08:00:00.000Z',
    })
  })

  it('are those carrying any of the suppliers, newest first', () => {
    expect(pickDraftsFor(drafts, ['a']).map((d) => d._id)).toEqual(['2', '1'])
    expect(pickDraftsFor(drafts, ['b', 'c']).map((d) => d._id)).toEqual(['3', '2'])
    expect(pickDraftsFor(drafts, ['z'])).toEqual([])
    expect(pickDraftsFor(drafts, ['', null, undefined])).toEqual([])
  })
})

describe('the draft a generate goes to unless the user picks', () => {
  it('is the newest that carries every supplier', () => {
    expect(defaultDraftFor(drafts, ['a'])?._id).toBe('2')
    expect(defaultDraftFor(drafts, ['a', 'b', 'a'])?._id).toBe('2')
  })

  it('is none — a new order — when no single draft carries them all, or no supplier is chosen', () => {
    expect(defaultDraftFor(drafts, ['a', 'c'])).toBeNull()
    expect(defaultDraftFor(drafts, ['z'])).toBeNull()
    expect(defaultDraftFor(drafts, [''])).toBeNull()
  })
})
