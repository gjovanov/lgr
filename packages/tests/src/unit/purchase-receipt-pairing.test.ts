import { describe, expect, it } from 'bun:test'
import type { FiledPurchaseRow } from 'services/biz/accounting-books/purchases/pairing'
import {
  amountsNear, pairPurchaseReceipts, receiptExclusion, receiptMarker, type StoreMovement,
} from 'services/biz/accounting-books/purchases/receipt-pairing'

/** FR-25 R4, slice 2: the filed purchase register against the stores' goods receipts. Made-up partners and amounts only. */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const PERIOD = '202609'
const SUPPLIER = 'BG999000191'
const OTHER = 'BG999000205'
const OWN = '999000999'

const filed = (over: Partial<FiledPurchaseRow> = {}): FiledPurchaseRow => ({
  period: PERIOD, docTypeCode: '01', docNumber: '0000000101', docDate: day('2026-09-10'), partnerVat: SUPPLIER,
  cells: { '03-31': 1000, '03-41': 200 }, ...over,
})

let seq = 0
/** A delivery of 10.00 net from the supplier, into PZ, on the row's day. */
const receipt = (over: Partial<StoreMovement> = {}): StoreMovement => ({
  org: 'PZ', label: `MOV-${++seq}`, type: 'receipt', status: 'completed', date: day('2026-09-10'), amount: 10,
  notes: `Доставки — 2026-09-10 — ТЕСТ ДОСТАВЧИК (stokrazp:${3000000000 + seq})`, hasSupplier: true, partnerIds: ['999000191'], ...over,
})

const pair = (rows: FiledPurchaseRow[], movements: StoreMovement[], laterRows: FiledPurchaseRow[] = []) =>
  pairPurchaseReceipts({ period: PERIOD, rows, laterRows, movements, ownIds: [`BG${OWN}`] })

describe('what a receipt is', () => {
  it('reads the stokrazp marker out of the notes', () => {
    expect(receiptMarker('Доставки — 2026-09-10 — X (stokrazp:3000619317)')).toBe('3000619317')
    expect(receiptMarker('Корекция от стокова разписка — 2026-09-10 (stokrazp:3000619317)')).toBe('3000619317')
    expect(receiptMarker('Reversal for voided invoice INV-1')).toBe('')
  })

  it('agrees on amounts to a cent a document, or 0.05% of the larger', () => {
    expect(amountsNear(1000, 1001, 1)).toBe(true)
    expect(amountsNear(1000, 1002, 1)).toBe(false)
    expect(amountsNear(100_000, 100_050, 1)).toBe(true)
    expect(amountsNear(100_000, 100_051, 1)).toBe(false)
  })

  it('leaves out each kind of movement that is no supplier delivery, for its own reason', () => {
    const own = new Set([OWN])
    expect(receiptExclusion(receipt(), own)).toBeNull()
    expect(receiptExclusion(receipt({ status: 'draft' }), own)).toBe('not booked')
    expect(receiptExclusion(receipt({ reversed: true }), own)).toBe('rolled back')
    expect(receiptExclusion(receipt({ invoice: 'outgoing' }), own)).toBe('sale taken back')
    expect(receiptExclusion(receipt({ invoice: 'gone' }), own)).toBe('names a document that is gone')
    expect(receiptExclusion(receipt({ invoice: 'incoming' }), own)).toBeNull()
    expect(receiptExclusion(receipt({ notes: 'Reversal of MOV-1 — document removed (docdelete:123)', hasSupplier: false }), own)).toBe('mirror of a removed document')
    expect(receiptExclusion(receipt({ hasSupplier: false, partnerIds: [], notes: 'Доставки — 2026-09-10 — 2000 КОРЕКЦИЯ (stokrazp:1)' }), own)).toBe('correction')
    expect(receiptExclusion(receipt({ hasSupplier: false, partnerIds: [], notes: 'Корекция — 2026-09-10 (corr:1) (+)' }), own)).toBe('correction')
    expect(receiptExclusion(receipt({ hasSupplier: false, partnerIds: [], notes: 'Доставки — 2026-09-10 (stokrazp:2)' }), own)).toBe('no supplier')
    expect(receiptExclusion(receipt({ partnerIds: [`BG${OWN}`] }), own)).toBe('the company itself')
    expect(receiptExclusion(receipt({ partnerIds: [] }), own)).toBe('supplier with no number')
  })
})

describe('pairing a month with the receipts', () => {
  it('pairs one row with one receipt to the base, and counts the month and the partner (tiers 1 and 2)', () => {
    const r = pair([filed()], [receipt({ org: 'PZ' })])
    expect(r.rows).toEqual({ total: 1, byType: { '01': 1 }, datedEarlier: 0, datedLater: 0 })
    expect(r.month).toMatchObject({ receipts: 1, receiptsByOrg: { PZ: 1 }, deliveries: 1, deliveriesByOrg: { PZ: 1 } })
    expect(r.partners).toMatchObject({ withRows: 1, withReceipts: 1, inBoth: 1, equalNet: 1, equalGross: 0, differ: 0, rowsOfEqual: 1 })
    expect(r.paired).toMatchObject({ total: 1, oneToOne: { net: 1, gross: 0 }, summed: { net: 0, gross: 0 }, sameDay: 1 })
    expect(r.receiptsOfMonth).toEqual({ inPeriod: 1, later: 0, notDeclared: 0 })
    expect(r.rowsUnpaired.total).toBe(0)
  })

  it('counts a receipt keyed with VAT apart: it agrees with the gross only', () => {
    const r = pair([filed()], [receipt({ amount: 12, date: day('2026-09-12') })])
    expect(r.paired.oneToOne).toEqual({ net: 0, gross: 1 })
    expect(r.paired.sameDay).toBe(0)
    expect(r.partners).toMatchObject({ equalNet: 0, equalGross: 1 })
  })

  it('pairs a row with a run of the partner\'s receipts of a few days, summed (tier 3), and counts one across both stores', () => {
    const r = pair(
      [filed({ cells: { '03-31': 3000, '03-41': 600 } })],
      [
        receipt({ org: 'PZ', amount: 10, date: day('2026-09-05') }),
        receipt({ org: 'SF', amount: 15, date: day('2026-09-07') }),
        receipt({ org: 'PZ', amount: 5, date: day('2026-09-09') }),
      ],
    )
    expect(r.paired).toMatchObject({ total: 1, summed: { net: 1, gross: 0 }, acrossStores: 1 })
    expect(r.partners.severalStores).toBe(1)
    expect(r.receiptsOfMonth.inPeriod).toBe(3)
  })

  it('guesses nothing: two receipts that fit one row, or two runs, leave it unpaired and counted', () => {
    const two = pair([filed()], [receipt(), receipt({ date: day('2026-09-11') })])
    expect(two.paired.total).toBe(0)
    expect(two.rowsUnpaired).toMatchObject({ total: 1, ambiguous: 1, partnerHasReceipts: 1 })
    const runs = pair([filed({ cells: { '03-31': 2000, '03-41': 400 } })], [
      receipt({ amount: 10, date: day('2026-09-06') }), receipt({ amount: 10, date: day('2026-09-07') }), receipt({ amount: 10, date: day('2026-09-08') }),
    ])
    expect(runs.paired.total).toBe(0)
    expect(runs.rowsUnpaired.ambiguous).toBe(1)
  })

  it('never pairs across partners or beyond the day window', () => {
    const r = pair([filed()], [receipt({ partnerIds: ['999000205'] }), receipt({ date: day('2026-09-20') })])
    expect(r.paired.total).toBe(0)
  })

  it('leaves out the sales taken back and the receipts with no supplier, each counted, and pairs none of them', () => {
    const r = pair([filed()], [
      receipt({ invoice: 'outgoing', partnerIds: ['999000191'] }),
      receipt({ hasSupplier: false, partnerIds: [], notes: 'Доставки — 2026-09-10 — 2000 КОРЕКЦИЯ (stokrazp:9)' }),
      receipt({ hasSupplier: false, partnerIds: [], notes: 'Доставки — 2026-09-10 (stokrazp:8)' }),
      receipt({ partnerIds: [OWN] }),
    ])
    expect(r.month.receipts).toBe(4)
    expect(r.month.deliveries).toBe(0)
    expect(r.month.excluded).toMatchObject({ 'sale taken back': 1, correction: 1, 'no supplier': 1, 'the company itself': 1 })
    expect(r.paired.total).toBe(0)
  })

  it('counts a delivery an LGR bill holds, and still pairs it', () => {
    const r = pair([filed()], [receipt({ invoice: 'incoming' })])
    expect(r.month.heldByBill).toBe(1)
    expect(r.paired.total).toBe(1)
  })

  it("pairs a credit note (03) with a receipt's negative lines, which take the supplier of the receipt under the same marker", () => {
    const delivery = receipt({ notes: 'Доставки — 2026-09-03 — ТЕСТ ДОСТАВЧИК (stokrazp:3000000777)', date: day('2026-09-03'), amount: 40 })
    const back = receipt({
      type: 'adjustment', hasSupplier: false, partnerIds: [], amount: 5, date: day('2026-09-03'),
      notes: 'Корекция от стокова разписка — 2026-09-03 (stokrazp:3000000777)',
    })
    const r = pair(
      [filed({ docTypeCode: '03', docNumber: '0000000103', docDate: day('2026-09-15'), cells: { '03-31': -500, '03-41': -100 } })],
      [delivery, back],
    )
    expect(r.month).toMatchObject({ returns: 1, returnsKept: 1 })
    expect(r.paired).toMatchObject({ total: 1, creditOneToOne: 1 })
    expect(r.returnsOfMonth).toEqual({ inPeriod: 1, later: 0, notDeclared: 0 })
    expect(r.receiptsOfMonth.notDeclared).toBe(1)
    // Tier 1 nets the return: 40 delivered less 5 back against −5 filed is not equal.
    expect(r.partners.differ).toBe(1)
  })

  it('leaves out a return whose receipt is a correction, or whose marker names no supplier', () => {
    const correction = receipt({ hasSupplier: false, partnerIds: [], notes: 'Доставки — 2026-09-03 — 2000 КОРЕКЦИЯ (stokrazp:55)' })
    const r = pair([], [
      correction,
      receipt({ type: 'adjustment', hasSupplier: false, partnerIds: [], notes: 'Корекция от стокова разписка — 2026-09-03 (stokrazp:55)' }),
      receipt({ type: 'adjustment', hasSupplier: false, partnerIds: [], notes: 'Корекция от стокова разписка — 2026-09-03 (stokrazp:66)' }),
      receipt({ type: 'return', hasSupplier: true }),
    ])
    expect(r.month.returns).toBe(3)
    expect(r.month.returnsExcluded).toMatchObject({ correction: 1, 'no supplier named': 1 })
    expect(r.month.returnsKept).toBe(1)
  })

  it("finds a receipt no row of the month took in a later period's register, and says the rest are not declared", () => {
    const r = pair(
      [],
      [receipt({ date: day('2026-09-29') }), receipt({ date: day('2026-09-15'), amount: 77 })],
      [filed({ period: '202610', docDate: day('2026-10-01') })],
    )
    expect(r.receiptsOfMonth).toEqual({ inPeriod: 0, later: 1, notDeclared: 1 })
  })

  it('pairs a row dated before its period with a receipt of that earlier month, and counts both', () => {
    const r = pair([filed({ docDate: day('2026-07-20') })], [receipt({ date: day('2026-07-20') })])
    expect(r.rows.datedEarlier).toBe(1)
    expect(r.paired).toMatchObject({ total: 1, receiptsOfEarlierMonth: 1 })
    expect(r.month.receipts).toBe(0)
  })

  it('splits the rows left by whether their partner delivered in the year; protocols and customs are counted by type', () => {
    const r = pair(
      [
        filed({ cells: { '03-31': 9900, '03-41': 1980 } }),
        filed({ partnerVat: OTHER }),
        filed({ partnerVat: '999999999999999' }),
        filed({ docTypeCode: '09', partnerVat: 'DE999999999' }),
        filed({ docTypeCode: '07', partnerVat: '999999999999999' }),
        filed({ docTypeCode: '03', cells: { '03-31': -300, '03-41': -60 } }),
      ],
      [receipt({ date: day('2026-02-10') })],
    )
    expect(r.rowsUnpaired).toMatchObject({
      total: 6, byType: { '01': 3, '03': 1, '07': 1, '09': 1 }, partnerHasReceipts: 2, partnerHasNone: 1, noPartner: 1,
    })
  })

  it('keeps every identifier out of everything but the details', () => {
    const r = pair([filed({ docNumber: '0000000701' })], [receipt({ amount: 55 })])
    const { details, ...counts } = r
    expect(JSON.stringify(counts)).not.toContain('0000000')
    expect(JSON.stringify(counts)).not.toContain('999000191')
    expect(JSON.stringify(counts)).not.toContain('MOV-')
    expect(details.length).toBeGreaterThan(0)
  })
})
