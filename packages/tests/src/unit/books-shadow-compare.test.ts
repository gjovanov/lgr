import { describe, expect, it } from 'bun:test'
import { compareMonth, compareRegisterRows, groupCounts, type MonthEntry, type RegisterRow } from 'services/biz/accounting-books/books-shadow-compare'
import type { ComparedLine } from 'services/biz/accounting-books/shadow-compare'

/**
 * FR-25 R3, slice 5: a store's month, the books against the shadow (§6.3). Made-up numbers, groups and amounts.
 */

const G1 = 'g1'
const G2 = 'g2'
const C = 'customer'

/** A sale as either ledger books it: per group `D702 K304` at a cost, then the customer for the net and the VAT. */
function sale(groups: [string, number, number][], net: number, vat: number, sign = 1): ComparedLine[] {
  const out: ComparedLine[] = []
  for (const [g, qty, cost] of groups) {
    out.push({ account: '702', side: 'debit', amount: sign * cost, quantity: sign * qty }, { account: '304', analyticId: g, side: 'credit', amount: sign * cost, quantity: sign * qty })
  }
  out.push(
    { account: '411', analyticId: C, side: 'debit', amount: sign * net }, { account: '702', side: 'credit', amount: sign * net },
    { account: '411', analyticId: C, side: 'debit', amount: sign * vat }, { account: '4532', side: 'credit', amount: sign * vat },
  )
  return out
}
const entry = (docNumber: string, lines: ComparedLine[], over: Partial<MonthEntry> = {}): MonthEntry => ({ docNumber, registerDocType: '1', lines, ...over })
/** The same lines, negative, on the same sides: an annulment, or the shadow's reversal. */
const reversed = (lines: ComparedLine[]) => lines.map(l => ({ ...l, amount: -l.amount, ...(l.quantity !== undefined ? { quantity: -l.quantity } : {}) }))

describe('a month, the books against the shadow', () => {
  it('a document booked alike is equal, and so are its groups and the month\'s cost of sales', () => {
    const lines = sale([[G1, 10, 5], [G2, 2, 4]], 20, 4)
    const r = compareMonth([entry('9000200001', lines)], [entry('9000200001', lines, { sourceId: 'd1' })])
    expect(r.documents).toEqual({ books: 1, shadow: 1, compared: 1, booksOnly: 0, shadowOnly: 0, typeDiffers: 0, noNumber: 0, severalInShadow: 0 })
    expect([r.compared.equal, r.compared.differs]).toEqual([1, 0])
    expect(r.groups).toEqual([
      { analyticId: G1, books: { quantity: 10, cost: 5 }, shadow: { quantity: 10, cost: 5 }, outcome: 'equal' },
      { analyticId: G2, books: { quantity: 2, cost: 4 }, shadow: { quantity: 2, cost: 4 }, outcome: 'equal' },
    ])
    expect(r.costOfSales).toEqual({ books: 9, shadow: 9, outcome: 'equal', booksOnly: 0, shadowOnly: 0 })
  })

  it('pairs by the register\'s digits, leading zeros dropped, and reads a number carried with a prefix as no number', () => {
    const lines = sale([[G1, 1, 1]], 2, 0.4)
    const r = compareMonth([entry('0090002000', lines), entry('ПР-17', lines)], [entry('90002000', lines, { sourceId: 'd1' })])
    expect([r.documents.compared, r.compared.equal, r.documents.noNumber]).toEqual([1, 1, 1])
  })

  it('a posting, its reversal and the next revision are one document of the month', () => {
    const first = sale([[G1, 10, 5]], 20, 4)
    const second = sale([[G1, 12, 6]], 24, 4.8)
    const r = compareMonth(
      [entry('9000200002', second)],
      [entry('9000200002', first, { sourceId: 'd2' }), entry('9000200002', reversed(first), { sourceId: 'd2' }), entry('9000200002', second, { sourceId: 'd2' })],
    )
    expect([r.documents.compared, r.compared.equal, r.documents.severalInShadow]).toEqual([1, 1, 0])
    expect(r.groups[0]).toMatchObject({ books: { quantity: 12, cost: 6 }, shadow: { quantity: 12, cost: 6 }, outcome: 'equal' })
  })

  it('a document annulled within the month is held by neither ledger; annulled in the shadow alone, it is the books\'', () => {
    const lines = sale([[G1, 10, 5]], 20, 4)
    const voided = [entry('9000200003', lines, { sourceId: 'd3' }), entry('9000200003', reversed(lines), { sourceId: 'd3' })]
    const both = compareMonth([entry('9000200003', lines), entry('9000200003', reversed(lines))], voided)
    expect([both.documents.books, both.documents.shadow, both.documents.compared, both.documents.booksOnly, both.documents.shadowOnly]).toEqual([0, 0, 0, 0, 0])
    const booksOnly = compareMonth([entry('9000200003', lines)], voided)
    expect([booksOnly.documents.booksOnly, booksOnly.costOfSales.booksOnly, booksOnly.groups]).toEqual([1, 5, []])
  })

  it('counts what one ledger holds alone, with the cost it books apart', () => {
    const r = compareMonth(
      [entry('9000200004', sale([[G1, 2, 1]], 4, 0.8))],
      [entry('9000200005', sale([[G2, 3, 6]], 9, 1.8), { sourceId: 'd5' }), entry('9000200006', sale([[G2, 1, 2]], 3, 0.6), { sourceId: 'd6' })],
    )
    expect([r.documents.booksOnly, r.documents.shadowOnly, r.documents.compared]).toEqual([1, 2, 0])
    expect(r.costOfSales).toEqual({ books: 0, shadow: 0, outcome: 'none', booksOnly: 1, shadowOnly: 8 })
  })

  it('an invoice in one ledger and a notice in the other is not compared; a type one side does not carry pairs', () => {
    const lines = sale([[G1, 1, 1]], 2, 0.4)
    const differs = compareMonth([entry('9000200007', lines, { registerDocType: '3' })], [entry('9000200007', lines, { registerDocType: '1', sourceId: 'd7' })])
    expect([differs.documents.typeDiffers, differs.documents.compared, differs.documents.booksOnly, differs.documents.shadowOnly]).toEqual([1, 0, 0, 0])
    const unknown = compareMonth([entry('9000200007', lines, { registerDocType: undefined })], [entry('9000200007', lines, { registerDocType: '01', sourceId: 'd7' })])
    expect([unknown.documents.typeDiffers, unknown.compared.equal]).toEqual([0, 1])
  })

  it('a group in another group\'s place is a quantity difference; the same quantities at another cost fall by how far', () => {
    const r = compareMonth(
      [entry('9000200008', sale([[G1, 10, 100], [G2, 5, 10]], 200, 40))],
      [entry('9000200008', sale([[G1, 10, 103], [G2, 4, 8], [G1, 1, 2]], 200, 40), { sourceId: 'd8' })],
    )
    expect([r.compared.differs, r.compared.by.cost, r.compared.cost.groups]).toEqual([1, 1, 1])
    expect(r.groups.map(g => [g.analyticId, g.outcome])).toEqual([[G1, 'quantity'], [G2, 'quantity']])
    const average = compareMonth(
      [entry('9000200009', sale([[G1, 10, 100], [G2, 5, 10]], 200, 40))],
      [entry('9000200009', sale([[G1, 10, 100.2], [G2, 5, 10.3]], 200, 40), { sourceId: 'd9' })],
    )
    expect([average.compared.cost.average, average.compared.costSpread.within05]).toEqual([1, 1])
    expect(average.groups.map(g => [g.analyticId, g.outcome])).toEqual([[G1, 'within05'], [G2, 'within5']])
    expect(groupCounts(average.groups)).toEqual({ equal: 0, quantity: 0, within05: 1, within5: 1, more: 0 })
    expect(average.costOfSales.outcome).toBe('within05')
  })

  it('a credit notice books negative on the same sides, and its groups give back what they took', () => {
    const r = compareMonth(
      [entry('9000200010', sale([[G1, 2, 1]], 4, 0.8, -1), { registerDocType: '3' })],
      [entry('9000200010', sale([[G1, 2, 1.2]], 4, 0.8, -1), { registerDocType: '3', sourceId: 'd10' })],
    )
    expect(r.groups).toEqual([{ analyticId: G1, books: { quantity: -2, cost: -1 }, shadow: { quantity: -2, cost: -1.2 }, outcome: 'more' }])
    expect(r.costOfSales).toMatchObject({ books: -1, shadow: -1.2, outcome: 'more' })
  })

  it('counts several LGR documents the shadow posts under one number', () => {
    const lines = sale([[G1, 1, 1]], 2, 0.4)
    const r = compareMonth([entry('9000200011', lines)], [entry('9000200011', lines, { sourceId: 'a' }), entry('9000200011', lines, { sourceId: 'b' })])
    expect([r.documents.severalInShadow, r.compared.differs]).toEqual([1, 1])
  })
})

describe('the sales register, the shadow\'s rows against the filed', () => {
  const at = new Date('2026-03-03T00:00:00.000Z')
  const row = (docNumber: string, base: number, over: Partial<RegisterRow> = {}): RegisterRow => ({
    docTypeCode: '01', docNumber, docDate: at, partnerVat: 'BG000000011', cells: { '02-10': base, '02-11': base, '02-20': base / 5, '02-21': base / 5 }, ...over,
  })

  it('equal, differing and on one side only, keyed by type and number', () => {
    const r = compareRegisterRows(
      [row('9000200001', 4000), row('9000200002', 2000), row('9000200004', -400, { docTypeCode: '03' }), row('9000200005', 100)],
      [row('9000200001', 4000), row('9000200002', 2100), row('9000200004', -400, { docTypeCode: '01' }), row('9000200006', 100)],
    )
    expect(r).toEqual({ shadow: 4, filed: 4, equal: 1, differs: { 'base + vat': 1 }, filedOnly: 2, shadowOnly: 2, several: 0 })
  })

  it('reads a type and a number however they are padded, and compares a number held twice by its first row', () => {
    const r = compareRegisterRows([row('9000200001', 4000, { docTypeCode: '1' })], [row('9000200001', 4000), row('09000200001', 4000, { partnerVat: '' })])
    expect([r.equal, r.several, r.filedOnly]).toEqual([1, 1, 0])
    // A number filed twice and never posted counts on its own side.
    const filedTwice = compareRegisterRows([], [row('9000200003', 100), row('9000200003', 100)])
    expect([filedTwice.filedOnly, filedTwice.several]).toEqual([1, 1])
  })
})
