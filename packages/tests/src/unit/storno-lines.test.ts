import { describe, it, expect } from 'bun:test'
import { partOfLine } from 'config/pos-totals'
import { isPlanRefusal, leftByMethod, planStorno, refundOfPart, saleLines, stornoLine, type StornoPlan } from 'services/biz/cash-register/storno-lines'
import { isImmutableRegisterDocument } from 'services/biz/cash-register/immutability'

/** FR-23 R3 — what a storno gives back of a sale, line by line, with nothing rounded away. */

const sale = (o: Record<string, unknown> = {}) => ({
  total: 58.9, subtotal: 50, taxTotal: 8.9, discountTotal: 0,
  lines: [
    { _id: 'a', description: 'Болт', quantity: 3, unitPrice: 10, taxRate: 20, lineTotal: 36, taxAmount: 6 },
    { _id: 'b', description: 'Гайка', quantity: 2, unitPrice: 5, taxRate: 20, lineTotal: 12, taxAmount: 2 },
    { _id: 'c', description: 'Шайба', quantity: 1, unitPrice: 10, taxRate: 9, lineTotal: 10.9, taxAmount: 0.9 },
  ],
  register: {},
  ...o,
})
const plan = (s: any, asked?: { lineId: string; quantity: number }[]) => {
  const p = planStorno(s, asked)
  if (isPlanRefusal(p)) throw new Error(JSON.stringify(p))
  return p as StornoPlan
}
const refused = (s: any, asked: { lineId: string; quantity: number }[]) => {
  const p: any = planStorno(s, asked)
  expect(isPlanRefusal(p)).toBe(true)
  return p
}
const claim = (lineId: string, milli: number) => ({ stornoId: 'x', lineId, milli, at: new Date() })

describe('partOfLine: the parts add up to the line in whatever pieces they come back', () => {
  it('for every way of splitting a line of a hard price', () => {
    const value = 999 // 9.99 over 7 units: no part divides evenly
    const sold = 7000
    for (const pieces of [[1000, 1000, 1000, 1000, 1000, 1000, 1000], [3000, 4000], [500, 500, 6000], [6999, 1], [7000]]) {
      let returned = 0
      let sum = 0
      for (const milli of pieces) {
        sum += partOfLine(value, sold, returned, milli)
        returned += milli
      }
      expect(sum).toBe(value)
    }
  })

  it('a whole number of a two-decimal price is exactly that, as a device adds it up', () => {
    expect(partOfLine(3600, 3000, 0, 1000)).toBe(1200)
    expect(partOfLine(3600, 3000, 1000, 2000)).toBe(2400)
  })

  it('a line that sold nothing is worth nothing, and never divides by zero', () => {
    expect(partOfLine(100, 0, 0, 1000)).toBe(0)
  })
})

describe('saleLines: each line a share of what the sale printed', () => {
  it('adds up to the sale per rate even when its lines do not, as a sale total rounded once per rate does not', () => {
    // Three lines of 1.005 gross round to 1.01 each and 3.02 together.
    const s = sale({
      total: 3.02,
      lines: [1, 2, 3].map(i => ({ _id: String(i), quantity: 1, unitPrice: 0.8375, taxRate: 20, lineTotal: 1.01 })),
    })
    const lines = saleLines(s)
    expect(lines.reduce((c, l) => c + l.value, 0)).toBe(302)
    expect(lines.map(l => l.value).sort()).toEqual([100, 101, 101])
  })

  it('a line that sold nothing is no line to return, and a line with no id is named by its place', () => {
    const s = sale({ lines: [{ description: 'note', quantity: 0, lineTotal: 0, taxRate: 20 }, { description: 'x', quantity: 1, unitPrice: 1, lineTotal: 1.2, taxRate: 20 }], total: 1.2 })
    const lines = saleLines(s)
    expect(lines).toHaveLength(1)
    expect(lines[0].key).toBe('#1')
    expect(lines[0].value).toBe(120)
  })

  it('reads what stornos took back', () => {
    const lines = saleLines(sale({ register: { stornoClaims: [claim('a', 1000), claim('a', 500), claim('c', 1000)] } }))
    expect(lines.map(l => [l.returned, l.left])).toEqual([[1500, 1500], [0, 2000], [1000, 0]])
  })
})

describe('planStorno', () => {
  it('all of an untouched sale, asked for or named line by line, is its own figures', () => {
    for (const asked of [undefined, [{ lineId: 'a', quantity: 3 }, { lineId: 'b', quantity: 2 }, { lineId: 'c', quantity: 1 }]]) {
      const p = plan(sale(), asked)
      expect(p.partial).toBe(false)
      expect(p.completes).toBe(true)
      expect(p.total).toBe(58.9)
      expect(p.subtotal).toBe(50)
      expect([...p.want]).toEqual([[20, 4800], [9, 1090]])
    }
  })

  it('a part is its lines: its money per rate, VAT out of the gross, and it leaves the rest', () => {
    const p = plan(sale(), [{ lineId: 'a', quantity: 1 }, { lineId: 'c', quantity: 1 }])
    expect(p.partial).toBe(true)
    expect(p.completes).toBe(false)
    expect(p.total).toBe(22.9)
    expect(p.taxTotal).toBe(2.9)
    expect(p.subtotal).toBe(20)
    expect([...p.want]).toEqual([[20, 1200], [9, 1090]])
    expect(p.lines.map(l => [l.key, l.milli, l.cents])).toEqual([['a', 1000, 1200], ['c', 1000, 1090]])
    expect([...p.read]).toEqual([['a', 0], ['b', 0], ['c', 0]])
  })

  it('no lines asked, on a sale partly back, is what is left, and it completes the sale', () => {
    const s = sale({ register: { stornoClaims: [claim('a', 1000), claim('c', 1000)], refundClaims: [{ stornoId: 'x', rate: 20, cents: 1200 }, { stornoId: 'x', rate: 9, cents: 1090 }] } })
    const p = plan(s)
    expect(p.partial).toBe(true)
    expect(p.completes).toBe(true)
    expect(p.total).toBe(36)
    expect(p.lines.map(l => [l.key, l.milli, l.cents])).toEqual([['a', 2000, 2400], ['b', 2000, 1200]])
  })

  it('a discount: its share of the money and the discount total', () => {
    const s = sale({
      total: 27, subtotal: 25, discountTotal: 2.5, taxTotal: 4.5,
      lines: [{ _id: 'a', quantity: 3, unitPrice: 8.3333, discount: 10, taxRate: 20, lineTotal: 27, taxAmount: 4.5 }],
    })
    const p = plan(s, [{ lineId: 'a', quantity: 1 }])
    expect(p.total).toBe(9)
    expect(p.discountTotal).toBe(0.83)
    expect(p.taxTotal).toBe(1.5)
    expect(p.subtotal).toBe(8.33)
  })

  it('refuses what is not there', () => {
    expect(refused(sale(), [{ lineId: 'nope', quantity: 1 }]).body.code).toBe('storno_line_unknown')
    for (const quantity of [0, -1, Number.NaN, 0.0004]) expect(refused(sale(), [{ lineId: 'a', quantity }]).body.code, String(quantity)).toBe('storno_quantity_invalid')
    const over = refused(sale({ register: { stornoClaims: [claim('a', 2000)] } }), [{ lineId: 'a', quantity: 2 }])
    expect(over.statusCode).toBe(409)
    expect(over.body).toMatchObject({ code: 'storno_exceeds_left', lines: [{ lineId: 'a', left: 1, requested: 2 }] })
    // The same line twice in one request is one quantity.
    expect(refused(sale(), [{ lineId: 'a', quantity: 2 }, { lineId: 'a', quantity: 2 }]).body.code).toBe('storno_exceeds_left')
    expect(refused(sale({ lines: [{ _id: 'a', quantity: 1, unitPrice: 1, taxRate: 20, lineTotal: 1.2 }, { _id: 'b', quantity: 1, unitPrice: -1, taxRate: 20, lineTotal: -1.2 }] }), [{ lineId: 'a', quantity: 1 }]).body.code).toBe('storno_not_splittable')
  })

  it('all of a sale with a negative line still goes as it always did, by its own figures', () => {
    const p = plan(sale({ total: 0, lines: [{ _id: 'a', quantity: 1, unitPrice: 1, taxRate: 20, lineTotal: 1.2 }, { _id: 'b', quantity: 1, unitPrice: -1, taxRate: 20, lineTotal: -1.2 }] }))
    expect(p.partial).toBe(false)
  })

  it('nothing left, on a sale that reads as partly back, plans nothing', () => {
    const s = sale({ register: { stornoClaims: [claim('a', 3000), claim('b', 2000), claim('c', 1000)] } })
    expect(refused(s, undefined as any).statusCode).toBe(400)
  })
})

describe('stornoLine', () => {
  it('the sale\'s line for what comes back, with nothing tying it to the sale or an invoice', () => {
    const s = sale({ lines: [{ _id: 'a', cashSaleLineId: 'z', productId: 'p', description: 'Болт', quantity: 3, unitPrice: 10, taxRate: 20, lineTotal: 36, taxAmount: 6 }], total: 36 })
    expect(stornoLine(s, { key: 'a', index: 0, rate: 20, milli: 1000, cents: 1200 })).toEqual({ productId: 'p', description: 'Болт', quantity: 1, unitPrice: 10, taxRate: 20, lineTotal: 12, taxAmount: 2 })
  })
})

describe('what a part goes back by when nobody names a method', () => {
  const paid = { payments: [{ method: 'cash', amount: 60 }, { method: 'card', amount: 40 }], total: 100 }

  it('what the sale still holds per method: what it kept, less what live stornos gave back that way', () => {
    expect(leftByMethod(paid, [])).toEqual([{ method: 'cash', cents: 6000 }, { method: 'card', cents: 4000 }])
    expect(leftByMethod(paid, [{ status: 'paid', payments: [{ method: 'cash', amount: 25 }] }, { status: 'voided', payments: [{ method: 'card', amount: 40 }] }]))
      .toEqual([{ method: 'cash', cents: 3500 }, { method: 'card', cents: 4000 }])
    // Paid back another way than it was paid: a method it never took is not one it holds, and none goes below nothing.
    expect(leftByMethod(paid, [{ status: 'paid', payments: [{ method: 'voucher', amount: 1 }, { method: 'card', amount: 50 }] }]))
      .toEqual([{ method: 'cash', cents: 6000 }, { method: 'card', cents: 0 }])
  })

  it('a sale with no rows: its header method holds its total', () => {
    expect(leftByMethod({ paymentMethod: 'card', total: 12 }, [])).toEqual([{ method: 'card', cents: 1200 }])
    expect(leftByMethod({ total: 12 }, [])).toEqual([{ method: 'cash', cents: 1200 }])
  })

  it('one method when one holds all of it, the first the sale names', () => {
    expect(refundOfPart([{ method: 'cash', cents: 6000 }, { method: 'card', cents: 4000 }], 3000)).toEqual([{ method: 'cash', amount: 30 }])
    expect(refundOfPart([{ method: 'cash', cents: 1000 }, { method: 'card', cents: 4000 }], 3000)).toEqual([{ method: 'card', amount: 30 }])
  })

  it('more than any one holds: in the sale\'s order', () => {
    expect(refundOfPart([{ method: 'cash', cents: 3000 }, { method: 'card', cents: 2890 }], 3600)).toEqual([{ method: 'cash', amount: 30 }, { method: 'card', amount: 6 }])
  })

  it('more than they all hold, because of what another way paid back: the rest falls on the first, and it always adds up', () => {
    expect(refundOfPart([{ method: 'cash', cents: 1000 }, { method: 'card', cents: 500 }], 2000)).toEqual([{ method: 'cash', amount: 15 }, { method: 'card', amount: 5 }])
    expect(refundOfPart([{ method: 'card', cents: 0 }], 700)).toEqual([{ method: 'card', amount: 7 }])
    expect(refundOfPart([], 700)).toEqual([{ method: 'cash', amount: 7 }])
  })
})

describe('a sale a storno has any claim on is a fiscal fact, whatever its origin', () => {
  it('reads as immutable partly as well as fully stornoed', () => {
    expect(isImmutableRegisterDocument({ type: 'cash_sale', register: { origin: 'backoffice', stornoState: 'partial' } })).toBe(true)
    expect(isImmutableRegisterDocument({ type: 'cash_sale', register: { origin: 'backoffice', stornoState: 'full' } })).toBe(true)
    expect(isImmutableRegisterDocument({ type: 'cash_sale', register: { origin: 'backoffice', stornoState: 'none' } })).toBe(false)
  })
})
