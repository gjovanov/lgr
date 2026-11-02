/**
 * `aggregatePosDay` on SYNTHETIC receipts. The field names and encodings are the ones the live POS list
 * uses (`posDocuments … "receipts"`, read 2026-11-02); every article, number and amount here is made up.
 * The real data was checked against 19 booked days, the month-aggregate control and the till's cash-box
 * closings; these tests pin the rules that check established.
 */
import { describe, it, expect } from 'bun:test'
import { aggregatePosDay, posReceiptDay, type PosReceipt } from 'services/biz/doc-import/map-plusminus-pos'

const DAY = '2026-03-02'
type L = [name: string, qty: number, net: number, gross?: number]
let seq = 0

/** A cash receipt (КБ) whose header adds up the way a real one does: |sum| = Σ sumWithVat − totalDiscountSum. */
function receipt(lines: L[], over: { day?: string; status?: 'complete' | 'return'; discountPct?: number; header?: Record<string, unknown> } = {}): PosReceipt {
  const day = (over.day ?? DAY).replace(/-/g, '')
  const status = over.status ?? 'complete'
  const sign = status === 'return' ? -1 : 1 // a return's lines are already negative; its header.sum is positive
  const mapped = lines.map(([name, qty, net, gross], i) => ({
    item: `GROUP:${name}`, name, quantity: String(sign * qty), sum: String(sign * net),
    sumWithVat: String(sign * (gross ?? Math.round(net * 1.2 * 100) / 100)), no: String(i + 1),
  }))
  const listGross = mapped.reduce((s, l) => s + Number(l.sumWithVat), 0)
  const discount = over.discountPct ? Math.round(Math.abs(listGross) * over.discountPct) / 100 : 0
  const paid = Math.round((Math.abs(listGross) - discount) * 100) / 100
  const n = ++seq
  return {
    num: String(n).padStart(8, '0'),
    date: day,
    header: {
      doc: 'КБ', status, vatPercent: '20', docNumber: String(5000 + n), closedOn: `${day}:101500123`,
      sum: paid.toFixed(2), paid: paid.toFixed(2),
      ...(over.discountPct ? { discountType: '1', discount: over.discountPct.toFixed(2), totalDiscountSum: discount.toFixed(2) } : {}),
      ...over.header,
    },
    lines: mapped,
  }
}

/** A payment taken at the till against an invoice: money, no lines. */
const payment = (): PosReceipt => ({
  num: '00000099', date: DAY.replace(/-/g, ''),
  header: { doc: 'ПЛ', status: 'complete', vatPercent: '20', docNumber: '90001', closedOn: `${DAY.replace(/-/g, '')}:110000000`, sum: '50.00', paid: '50.00', invoice: 'INV 1 20260302' },
})

describe('aggregatePosDay', () => {
  it('sums quantities and net values per article across receipts', () => {
    const agg = aggregatePosDay([
      receipt([['Item A', 2, 5.0], ['Item B', 1, 10.0]]),
      receipt([['Item A', 1, 2.5]]),
    ], DAY)
    expect(agg.rows).toEqual([{ name: 'Item A', qty: 3, value: 7.5 }, { name: 'Item B', qty: 1, value: 10 }])
    expect(agg.totalQty).toBe(4)
    expect(agg.totalValueNet).toBe(17.5)
    expect(agg.totalValueGross).toBe(21) // 6 + 12 + 3
  })

  it('applies a receipt-level percentage discount to every line (value only, never the quantity)', () => {
    const agg = aggregatePosDay([receipt([['Item A', 2, 10.0], ['Item B', 1, 4.0]], { discountPct: 10 })], DAY)
    expect(agg.rows).toEqual([{ name: 'Item A', qty: 2, value: 9 }, { name: 'Item B', qty: 1, value: 3.6 }])
    expect(agg.totalValueGross).toBe(15.12) // (12 + 4.8) − 10 %
  })

  it('takes the value from the NET sum, not from the cent-rounded gross price divided back', () => {
    // 200 pieces: net 4.30, but the gross is 6.00 (a 0.03 unit price), not 4.30 × 1.2 = 5.16. 50 % off → 2.15.
    const agg = aggregatePosDay([receipt([['Item S', 200, 4.3, 6.0]], { discountPct: 50 })], DAY)
    expect(agg.rows).toEqual([{ name: 'Item S', qty: 200, value: 2.15 }])
    expect(agg.totalValueGross).toBe(3) // what was actually paid
  })

  it('nets a return (negative lines already) against a sale and drops the article that nets to zero', () => {
    const agg = aggregatePosDay([
      receipt([['Item A', 1, 8.0]]),
      receipt([['Item A', 1, 8.0]], { status: 'return' }),
      receipt([['Item B', 2, 3.0]]),
    ], DAY)
    expect(agg.rows).toEqual([{ name: 'Item B', qty: 2, value: 3 }])
    expect(agg.totalValueGross).toBe(3.6) // 9.6 − 9.6 + 3.6
  })

  it('never flips a return twice: a lone return is negative', () => {
    const agg = aggregatePosDay([receipt([['Item A', 2, 4.0]], { status: 'return' })], DAY)
    expect(agg.rows).toEqual([{ name: 'Item A', qty: -2, value: -4 }])
    expect(agg.totalQty).toBe(-2)
    expect(agg.totalValueNet).toBe(-4)
    expect(agg.totalValueGross).toBe(-4.8)
  })

  it('skips payments taken against invoices (ПЛ): money, not a sale of goods', () => {
    const agg = aggregatePosDay([payment(), receipt([['Item A', 1, 5.0]]), payment()], DAY)
    expect(agg.rows).toEqual([{ name: 'Item A', qty: 1, value: 5 }])
    expect(agg.totalValueGross).toBe(6)
  })

  it('keeps fractional quantities to three decimals and absorbs float noise', () => {
    const agg = aggregatePosDay([
      receipt([['Item L', 0.1, 0.1]]),
      receipt([['Item L', 0.2, 0.2]]),
      receipt([['Item M', 1214.755, 10.0]]),
    ], DAY)
    expect(agg.rows).toEqual([{ name: 'Item L', qty: 0.3, value: 0.3 }, { name: 'Item M', qty: 1214.755, value: 10 }])
  })

  it('names a line by `name`, falling back to `item` without its group prefix', () => {
    const noName = receipt([['Item A', 1, 5.0]])
    delete (noName.lines![0] as Record<string, unknown>).name
    noName.lines![0].item = 'GROUP:  Item A  '
    expect(aggregatePosDay([noName], DAY).rows.map(r => r.name)).toEqual(['Item A'])
  })

  it('treats a line with no sum as a zero-value line that still counts its quantity', () => {
    const r = receipt([['Item A', 1, 5.0], ['Item G', 3, 0]])
    delete (r.lines![1] as Record<string, unknown>).sum
    delete (r.lines![1] as Record<string, unknown>).sumWithVat
    const agg = aggregatePosDay([r], DAY)
    expect(agg.rows).toEqual([{ name: 'Item A', qty: 1, value: 5 }, { name: 'Item G', qty: 3, value: 0 }])
  })

  it('returns an empty aggregate for a day with nothing in it', () => {
    expect(aggregatePosDay([], DAY)).toEqual({ rows: [], totalQty: 0, totalValueNet: 0, totalValueGross: 0 })
    expect(aggregatePosDay([payment()], DAY).rows).toEqual([])
  })
})

describe('aggregatePosDay refuses what it has not seen', () => {
  it('a receipt closed on another day', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { day: '2026-03-03' })], DAY)).toThrow(/closed on 2026-03-03, not 2026-03-02/)
  })
  it('a receipt that was never closed', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { closedOn: '' } })], DAY)).toThrow(/no closedOn/)
  })
  it('another document type', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { doc: 'ФП' } })], DAY)).toThrow(/header\.doc="ФП"/)
  })
  it('another status', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { status: 'canceled' } })], DAY)).toThrow(/status "canceled"/)
  })
  it('a discount type other than percent, and a discount without a type', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { discountType: '2', discount: '1.00' } })], DAY)).toThrow(/unknown discount type "2"/)
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { discount: '5.00' } })], DAY)).toThrow(/no discountType/)
  })
  it('a VAT rate other than 20, and mixed rates', () => {
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]], { header: { vatPercent: '9' } })], DAY)).toThrow(/VAT rate 9%/)
    expect(() => aggregatePosDay([receipt([['Item A', 1, 5.0]]), receipt([['Item B', 1, 5.0]], { header: { vatPercent: '0' } })], DAY)).toThrow(/mixed VAT rates/)
  })
  it('a receipt that does not add up (a line is missing), naming it', () => {
    const r = receipt([['Item A', 1, 5.0], ['Item B', 1, 5.0]])
    r.lines!.pop()
    expect(() => aggregatePosDay([r], DAY)).toThrow(new RegExp(`receipt ${String(r.header!.docNumber)} does not add up`))
  })
})

describe('posReceiptDay', () => {
  it('reads the close day from closedOn', () => {
    expect(posReceiptDay({ header: { closedOn: '20261029:162903826' } })).toBe('2026-10-29')
    expect(posReceiptDay({ header: { closedOn: '20261029' } })).toBe('2026-10-29')
  })
  it('is null for a receipt that was never closed, even if it was opened', () => {
    expect(posReceiptDay({ header: { openedOn: '20261029:162903826' } })).toBeNull()
    expect(posReceiptDay({ header: { closedOn: '' } })).toBeNull()
    expect(posReceiptDay({})).toBeNull()
  })
})
