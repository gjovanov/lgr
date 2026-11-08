import { describe, it, expect } from 'bun:test'
import { computePosTotals, roundCents } from 'config/pos-totals'
import {
  apportion, deviceTaxTotal, deviceTotals, documentText, fiscalUnitPrice, grossByRate, linesOnDevice, movesPrintedMoney, paymentText, printsExactly, receiptBody, receiptedByRate, refundText, splitByRate,
} from 'services/biz/cash-register/receipt-lines'
import { receiptRefusalKey, receiptRefusalMessage, receiptRefusalParams, isFailedPrint } from 'ui-shared/cash-register/receipt-refusal'
import { kindColor } from 'ui-shared/cash-register/journal-kind'
import { issuedReceiptNotice, joinedSaleReceipt } from '../../../invoicing-ui/src/composables/document-issue'
import { isImportedDocument, printsAtCounter } from 'services/biz/cash-register/payment-receipt.service'
import { isImmutableRegisterDocument } from 'services/biz/cash-register/immutability'
import { sequenceGroupFor } from 'services/biz/sequence-registry'
import { posRowSign, receiptTookMoney } from 'services/biz/cash-register/counting'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import en from '../../../ui-shared/src/locales/en.json'
import bg from '../../../ui-shared/src/locales/bg.json'
import de from '../../../ui-shared/src/locales/de.json'
import mk from '../../../ui-shared/src/locales/mk.json'

/** FR-23 §2.2 — what a payment's receipt prints, with no database and no device in the way. */

const line = (taxRate: number, lineTotal: number, extra: Record<string, unknown> = {}) => ({
  description: 'x', quantity: 1, unitPrice: lineTotal / (1 + taxRate / 100), taxRate,
  taxAmount: +(lineTotal * taxRate / (100 + taxRate)).toFixed(2), lineTotal, ...extra,
})

describe('apportion', () => {
  it('shares every cent out, the largest remainders first', () => {
    expect(apportion([1, 1, 1], 100)).toEqual([34, 33, 33])
    expect(apportion([7001, 3000], 3333)).toEqual([2333, 1000])
    expect(apportion([1, 2, 3], 0)).toEqual([0, 0, 0])
  })

  it('never gives a share more than its weight when less than the whole is shared', () => {
    const weights = [1, 1, 1, 9997]
    for (let cents = 1; cents < 10000; cents += 97) {
      const shares = apportion(weights, cents)!
      expect(shares.reduce((s, n) => s + n, 0)).toBe(cents)
      shares.forEach((s, i) => expect(s).toBeLessThanOrEqual(weights[i]))
    }
  })

  it('refuses a negative weight, and nothing to weigh', () => {
    expect(apportion([100, -10], 50)).toBeNull()
    expect(apportion([0, 0], 50)).toBeNull()
    expect(apportion([], 50)).toBeNull()
  })
})

describe('the money per VAT rate', () => {
  it('adds up to the total, when lines and total differ by rounding', () => {
    const doc = { total: 100.01, lines: [line(20, 70), line(9, 30)] }
    const gross = grossByRate(doc)!
    expect(gross.reduce((s, g) => +(s + g.gross).toFixed(2), 0)).toBe(100.01)
  })

  it('takes several lines of a rate as one', () => {
    expect(grossByRate({ total: 30, lines: [line(20, 10), line(20, 20)] })).toEqual([{ rate: 20, gross: 30 }])
  })

  it('a rate with a negative total cannot be shared', () => {
    expect(grossByRate({ total: 40, lines: [line(20, 50), line(9, -10)] })).toBeNull()
  })
})

describe('a payment split per rate', () => {
  const gross = [{ rate: 20, gross: 70.01 }, { rate: 9, gross: 30 }]

  it('is pro rata, and adds up to the payment', () => {
    const shares = splitByRate(gross, new Map(), 50)!
    expect(shares).toEqual([{ rate: 20, gross: 35 }, { rate: 9, gross: 15 }])
  })

  it('the last one takes what is left of each rate, whatever the rounding before it left', () => {
    let left = new Map<number, number>()
    const parts = [0.01, 0.01, 33.33, 33.33, 33.33]
    const printed: { lines: any[] }[] = []
    for (const part of parts) {
      const shares = splitByRate(gross, left, part)!
      printed.push({ lines: shares.map(s => ({ taxRate: s.rate, lineTotal: s.gross })) })
      left = receiptedByRate(printed)
    }
    expect(left.get(20)).toBe(7001)
    expect(left.get(9)).toBe(3000)
  })

  it('leaves out a rate that gets nothing: a device takes no line of 0.00', () => {
    const shares = splitByRate([{ rate: 20, gross: 1000 }, { rate: 9, gross: 0.01 }], new Map(), 0.01)!
    expect(shares).toHaveLength(1)
    expect(shares[0].rate).toBe(20)
  })

  it('refuses more than what no receipt holds', () => {
    expect(splitByRate(gross, new Map([[20, 7001], [9, 3000]]), 0.01)).toBeNull()
  })
})

describe('what a device would add the lines up to', () => {
  const doc = (lines: any[], total: number) => ({ lines, total })
  const shares = (d: any) => grossByRate(d)!

  it('agrees when the rounded price times the quantity is the line', () => {
    const d = doc([{ quantity: 2, unitPrice: 10, taxRate: 20, lineTotal: 24 }], 24)
    expect(printsExactly(d, shares(d))).toBe(true)
  })

  it('disagrees for a small price in a large quantity', () => {
    const d = doc([{ quantity: 1000, unitPrice: 0.1234, taxRate: 20, lineTotal: 148.08 }], 148.08)
    expect(fiscalUnitPrice(0.1234, 20)).toBe(0.15)
    expect(printsExactly(d, shares(d))).toBe(false)
  })

  it('takes a discount off as a device takes it', () => {
    const d = doc([{ quantity: 2, unitPrice: 10, discount: 10, taxRate: 20, lineTotal: 21.6 }], 21.6)
    expect(printsExactly(d, shares(d))).toBe(true)
  })

  it('a percent off the drivers would send rounded is not exact: the device would total another amount (#574)', () => {
    // 1200.00 gross less 12.345 % is 1051.86; sent as 12.34, as every driver sends it, the device makes it 1051.92.
    const d = doc([{ quantity: 1, unitPrice: 1000, discount: 12.345, taxRate: 20, lineTotal: 1051.86 }], 1051.86)
    expect(printsExactly(d, shares(d))).toBe(false)
    const sent = doc([{ quantity: 1, unitPrice: 1000, discount: 12.34, taxRate: 20, lineTotal: 1051.92 }], 1051.92)
    expect(printsExactly(sent, shares(sent))).toBe(true)
    const float = doc([{ quantity: 1, unitPrice: 1000, discount: 0.1 + 0.2, taxRate: 20, lineTotal: 1196.4 }], 1196.4)
    expect(printsExactly(float, shares(float))).toBe(true)
  })

  it('a percent off below zero is not exact: a Datecs or a Tremol drops it (#574)', () => {
    const d = doc([{ quantity: 2, unitPrice: 10, discount: -10, taxRate: 20, lineTotal: 26.4 }], 26.4)
    expect(printsExactly(d, shares(d))).toBe(false)
  })

  it('a device takes no quantity or price below zero, nor a 100 % discount', () => {
    const lines = [{ quantity: -1, unitPrice: 10, taxRate: 20, lineTotal: 12 }]
    expect(printsExactly(doc(lines, 12), [{ rate: 20, gross: 12 }])).toBe(false)
    const free = [{ quantity: 1, unitPrice: 10, discount: 100, taxRate: 20, lineTotal: 0 }]
    expect(printsExactly(doc(free, 0), [{ rate: 20, gross: 0 }])).toBe(false)
  })
})

describe('what a device is given for a document (D2)', () => {
  const sold = (lines: any[], total: number) => ({ type: 'cash_sale', invoiceNumber: 'CS-2026-00001', lines, total })
  const onThem = (lines: any[]) => lines.reduce((s, l) => s + Math.round(fiscalUnitPrice(l.unitPrice, l.taxRate) * l.quantity * 100), 0) / 100

  it('prices that reproduce the money: the lines as they are', () => {
    const lines = [{ description: 'Болт', quantity: 2, unitPrice: 10, taxRate: 20, lineTotal: 24 }]
    expect(linesOnDevice(sold(lines, 24), 'x')).toEqual(lines)
  })

  it('prices that do not: one line per rate, at the exact gross, whichever way the device would have gone', () => {
    for (const [quantity, unitPrice, total] of [[1000, 0.0533, 63.96], [100, 3.33, 399.6], [3, 0.1234, 0.44]] as const) {
      const out = linesOnDevice(sold([{ description: 'Винт', quantity, unitPrice, taxRate: 20, lineTotal: total }], total), 'Продажба № 1')
      expect(out).toHaveLength(1)
      expect(out[0]).toMatchObject({ description: 'Продажба № 1', quantity: 1, taxRate: 20, lineTotal: total })
      expect(onThem(out)).toBe(total)
    }
  })

  it('two rates: one line each, and one that alone would come out does not stay as it is', () => {
    const lines = [
      { description: 'Винт', quantity: 1000, unitPrice: 0.0533, taxRate: 20, lineTotal: 63.96 },
      { description: 'Книга', quantity: 1, unitPrice: 10, taxRate: 9, lineTotal: 10.9 },
    ]
    const out = linesOnDevice(sold(lines, 74.86), 'n')
    expect(out.map(l => [l.taxRate, l.lineTotal])).toEqual([[20, 63.96], [9, 10.9]])
    expect(onThem(out)).toBe(74.86)
  })

  it('a line a device refuses goes the same way: a discount of all of it, a quantity of nothing', () => {
    const lines = [
      { description: 'Болт', quantity: 1, unitPrice: 10, taxRate: 20, lineTotal: 12 },
      { description: 'Подарък', quantity: 1, unitPrice: 5, discount: 100, taxRate: 20, lineTotal: 0 },
    ]
    expect(linesOnDevice(sold(lines, 12), 'n').map(l => [l.quantity, l.lineTotal])).toEqual([[1, 12]])
    expect(linesOnDevice(sold([{ ...lines[0], quantity: 0 }, lines[0]], 12), 'n').map(l => l.lineTotal)).toEqual([12])
  })

  it('a document that comes to nothing has no line to print per rate: its own, for the driver to say', () => {
    const lines = [{ description: 'Подарък', quantity: 1, unitPrice: 5, discount: 100, taxRate: 20, lineTotal: 0 }]
    expect(linesOnDevice(sold(lines, 0), 'n')).toEqual(lines)
  })

  it('a rate with a negative total: no device takes it either way, so the driver is left to refuse the lines', () => {
    const lines = [{ description: 'Отстъпка', quantity: 1, unitPrice: -5, taxRate: 20, lineTotal: -6 }]
    expect(linesOnDevice(sold(lines, -6), 'n')).toEqual(lines)
  })

  it('what such a line is called: the sale\'s number survives a driver that cuts a name', () => {
    expect(documentText({ type: 'cash_sale', invoiceNumber: 'CS-2026-00012' })).toBe('Продажба № CS-2026-00012')
    expect(refundText({ type: 'cash_sale', invoiceNumber: 'CS-2026-00012' })).toBe('Връщане по продажба № CS-2026-00012')
    expect(refundText({ type: 'cash_sale', invoiceNumber: 'CS-2026-00012' }, 34)).toBe('Продажба № CS-2026-00012')
  })
})

describe('a receipt\'s body', () => {
  const invoice = (extra: Record<string, unknown> = {}) => ({
    type: 'invoice', invoiceNumber: 'INV-2026-00123', total: 24, discountTotal: 0,
    lines: [{ productId: 'p1', description: 'Болт', quantity: 2, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 4, lineTotal: 24, warehouseId: 'w', orderRef: { reservationId: 'r' } }],
    ...extra,
  })
  const body = (o: Partial<Parameters<typeof receiptBody>[0]> = {}) =>
    receiptBody({ doc: invoice(), amount: 24, whole: true, printsText: true, receipts: [], ...o })!

  it('whole: the document\'s lines and its number under them', () => {
    const b = body()
    expect(b.receiptText).toBe('Фактура № INV-2026-00123')
    expect(b.lines).toHaveLength(1)
    expect(b.lines[0]).toMatchObject({ productId: 'p1', description: 'Болт', quantity: 2, unitPrice: 10, taxAmount: 4, lineTotal: 24 })
    expect(b).toMatchObject({ total: 24, taxTotal: 4, subtotal: 20 })
  })

  it('whole: the lines keep their own VAT, and the receipt\'s is the device\'s, out of each rate\'s gross (#554)', () => {
    const washer = { description: 'Шайба', quantity: 1, unit: 'бр.', unitPrice: 0.125, taxRate: 20, taxAmount: 0.03, lineTotal: 0.15 }
    const b = receiptBody({ doc: invoice({ total: 0.3, lines: [washer, { ...washer }] }), amount: 0.3, whole: true, printsText: true, receipts: [] })!
    expect(b.receiptText).toBe('Фактура № INV-2026-00123')
    expect(b.lines.map(l => l.taxAmount)).toEqual([0.03, 0.03])
    expect(b).toMatchObject({ total: 0.3, taxTotal: 0.05, subtotal: 0.25 })
  })

  it('a receipt line carries nothing that ties it to orders, warehouses or sales', () => {
    const l: any = body().lines[0]
    expect(l.warehouseId).toBeUndefined()
    expect(l.orderRef).toBeUndefined()
    expect(l.cashSaleLineId).toBeUndefined()
  })

  it('whole on a device with no text line: the number is the line\'s name', () => {
    const b = body({ printsText: false })
    expect(b.receiptText).toBeUndefined()
    expect(b.lines.map(l => [l.description, l.quantity, l.lineTotal])).toEqual([['Фактура № INV-2026-00123', 1, 24]])
  })

  it('a part: a line per rate, „Плащане по фактура № …", and no product', () => {
    const b = body({ whole: false, amount: 10 })
    expect(b.receiptText).toBeUndefined()
    expect(b.lines).toHaveLength(1)
    expect(b.lines[0]).toMatchObject({ description: 'Плащане по фактура № INV-2026-00123', quantity: 1, lineTotal: 10 })
    expect((b.lines[0] as any).productId).toBeUndefined()
  })

  it('a rate line gives the device exactly its gross back, VAT out of it as a device takes it', () => {
    for (const [gross, rate] of [[10, 20], [0.01, 20], [33.33, 9], [1234.56, 20], [7.77, 0]] as const) {
      const [l] = receiptBody({ doc: { ...invoice(), total: gross, lines: [{ taxRate: rate, lineTotal: gross }] }, amount: gross, whole: false, printsText: true, receipts: [] })!.lines
      expect(fiscalUnitPrice(l.unitPrice, l.taxRate)).toBe(gross)
      expect(l.lineTotal).toBe(gross)
      expect(+(l.lineTotal * rate / (100 + rate)).toFixed(2)).toBe(l.taxAmount)
    }
  })

  it('a debit note names itself', () => {
    const d = { type: 'debit_note', invoiceNumber: 'INV-2026-00124' }
    expect(documentText(d)).toBe('Дебитно известие № INV-2026-00124')
    expect(paymentText(d)).toBe('Плащане по дебитно известие № INV-2026-00124')
  })

  it('money that cannot be split has no body', () => {
    const lines = [{ taxRate: 20, lineTotal: 50 }, { taxRate: 9, lineTotal: -10 }]
    expect(receiptBody({ doc: invoice({ total: 40, lines }), amount: 40, whole: false, printsText: true, receipts: [] })).toBeNull()
  })
})

describe('#554: the VAT a sale stores is what its device takes out', () => {
  type Cart = { quantity: number; unitPrice: number; taxRate: number }[]
  /** A till sale as it is stored: the terminal's net and rounded VAT per line, summed (`fromPosTransaction`), its total `computePosTotals`'. */
  const tillSale = (cart: Cart) => ({
    type: 'cash_sale', invoiceNumber: 'CS-2026-00001', total: computePosTotals(cart).total, discountTotal: 0,
    lines: cart.map(c => {
      const taxAmount = Math.round(c.quantity * c.unitPrice * (c.taxRate / 100) * 100) / 100
      return { description: 'x', ...c, discount: 0, taxAmount, lineTotal: Math.round((c.quantity * c.unitPrice + taxAmount) * 100) / 100 }
    }),
  })
  /** What a device makes of lines: each at its rounded gross price, summed per rate, the VAT out of each sum. */
  const vatOnDevice = (lines: Cart) => {
    const byRate = new Map<number, number>()
    for (const l of lines) byRate.set(l.taxRate, roundCents((byRate.get(l.taxRate) || 0) + roundCents(fiscalUnitPrice(l.unitPrice, l.taxRate) * l.quantity)))
    return roundCents([...byRate].reduce((s, [rate, gross]) => s + roundCents((gross * rate) / (100 + rate)), 0))
  }

  it('a two-rate sale whose lines do not print exactly: out of the gross the device is given, not each rate\'s own', () => {
    const cart = [{ quantity: 1, unitPrice: 4.2233, taxRate: 20 }, { quantity: 1, unitPrice: 5.5555, taxRate: 9 }]
    const sale = tillSale(cart)
    // Each rate's own gross, 5.07 + 6.06, gives 0.85 + 0.50.
    expect(computePosTotals(cart)).toMatchObject({ total: 11.13, taxTotal: 1.35 })
    // The lines say 5.06 and 6.06, so the device is given 5.06 and 6.07, and takes 0.84 + 0.50 out.
    const gross = grossByRate(sale)!
    expect(gross).toEqual([{ rate: 20, gross: 5.06 }, { rate: 9, gross: 6.07 }])
    expect(printsExactly(sale, gross)).toBe(false)
    expect(vatOnDevice(linesOnDevice(sale, 'n') as Cart)).toBe(1.34)
    expect(deviceTaxTotal(sale)).toBe(1.34)
    expect(deviceTotals(sale)).toEqual({ taxTotal: 1.34, subtotal: 9.79 })
  })

  it('any till sale: what it stores is what its device takes out, and its net and VAT make its total', () => {
    let seed = 554
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    let moved = 0
    for (let i = 0; i < 3000; i++) {
      const cart = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
        quantity: 1 + Math.floor(rnd() * (rnd() < 0.2 ? 200 : 5)),
        unitPrice: +(0.05 + rnd() * 40).toFixed(rnd() < 0.5 ? 4 : 2),
        taxRate: [20, 20, 20, 9, 0][Math.floor(rnd() * 5)],
      }))
      const sale = tillSale(cart)
      const stored = deviceTotals(sale)!
      expect(stored.taxTotal).toBe(vatOnDevice(linesOnDevice(sale, 'n') as Cart))
      expect(roundCents(stored.subtotal + stored.taxTotal)).toBe(sale.total)
      if (stored.taxTotal !== computePosTotals(cart).taxTotal) {
        moved++
        // Only ever a two-rate sale its lines cannot print, and only by a cent.
        expect(new Set(cart.map(c => c.taxRate)).size).toBeGreaterThan(1)
        expect(printsExactly(sale, grossByRate(sale)!)).toBe(false)
        expect(Math.abs(stored.taxTotal - computePosTotals(cart).taxTotal)).toBeLessThan(0.015)
      }
    }
    // The case this is about turns up in the sample, or the loop proves nothing.
    expect(moved).toBeGreaterThan(0)
  })

  it('one rate, or lines that print exactly: the VAT each rate\'s own gross gives, as before', () => {
    for (const cart of [
      [{ quantity: 3, unitPrice: 17.8952, taxRate: 20 }, { quantity: 7, unitPrice: 4.2233, taxRate: 20 }],
      [{ quantity: 2, unitPrice: 10, taxRate: 20 }, { quantity: 3, unitPrice: 1, taxRate: 9 }],
    ]) {
      expect(deviceTotals(tillSale(cart))).toEqual({ taxTotal: computePosTotals(cart).taxTotal, subtotal: computePosTotals(cart).subtotal })
    }
  })

  it('a discount stays in the net, as the door computed it', () => {
    const sale = { total: 10.8, discountTotal: 1, lines: [{ quantity: 1, unitPrice: 10, discount: 10, taxRate: 20, lineTotal: 10.8 }] }
    expect(deviceTotals(sale)).toEqual({ taxTotal: 1.8, subtotal: 10 })
  })

  it('a rate with a negative total shares nothing: the door\'s own totals stand', () => {
    expect(deviceTotals({ total: 40, lines: [{ taxRate: 20, lineTotal: 50 }, { taxRate: 9, lineTotal: -10 }] })).toBeNull()
  })
})

describe('what an edit may not do once a receipt printed', () => {
  const doc = { total: 24, currency: 'EUR', lines: [{ taxRate: 20, lineTotal: 24 }] }

  it('moves nothing when the money stays', () => {
    expect(movesPrintedMoney(doc, {})).toBe(false)
    expect(movesPrintedMoney(doc, { total: 24, lines: [{ taxRate: 20, lineTotal: 24 }], currency: 'EUR' })).toBe(false)
    // A cent's slack on a line, the total the same: a form rounding its own way.
    expect(movesPrintedMoney(doc, { total: 24, lines: [{ taxRate: 20, lineTotal: 23.99 }] })).toBe(false)
  })

  it('catches the total, the rates under it, and the currency', () => {
    expect(movesPrintedMoney(doc, { total: 24.01 })).toBe(true)
    expect(movesPrintedMoney(doc, { lines: [{ taxRate: 9, lineTotal: 24 }] })).toBe(true)
    expect(movesPrintedMoney(doc, { lines: [{ taxRate: 20, lineTotal: 20 }] })).toBe(true)
    expect(movesPrintedMoney(doc, { currency: 'USD' })).toBe(true)
  })

  it('reads a line sent without its total as the API computes one', () => {
    expect(movesPrintedMoney(doc, { lines: [{ quantity: 2, unitPrice: 10, taxRate: 20 }] })).toBe(false)
    expect(movesPrintedMoney(doc, { lines: [{ quantity: 3, unitPrice: 10, taxRate: 20 }] })).toBe(true)
  })
})

describe('what prints at the counter', () => {
  const sale = (extra: Record<string, unknown> = {}) => ({ direction: 'outgoing', type: 'invoice', ...extra })

  it('cash and card on an outgoing invoice or debit note', () => {
    for (const method of ['cash', 'card']) {
      expect(printsAtCounter(sale(), method, true)).toBe(true)
      expect(printsAtCounter(sale(), method, false)).toBe(true)
      expect(printsAtCounter(sale({ type: 'debit_note' }), method, false)).toBe(true)
    }
  })

  it('cash on delivery only as an invoice is issued', () => {
    expect(printsAtCounter(sale(), 'cash_on_delivery', true)).toBe(true)
    expect(printsAtCounter(sale(), 'cash_on_delivery', false)).toBe(false)
    expect(printsAtCounter(sale({ type: 'debit_note' }), 'cash_on_delivery', true)).toBe(false)
  })

  it('nothing else', () => {
    for (const method of ['bank_transfer', 'other', undefined]) expect(printsAtCounter(sale(), method, true)).toBe(false)
    for (const type of ['credit_note', 'proforma', 'cash_sale', 'cash_storno', 'payment_receipt']) {
      expect(printsAtCounter(sale({ type }), 'cash', true)).toBe(false)
    }
    expect(printsAtCounter(sale({ direction: 'incoming' }), 'cash', true)).toBe(false)
    expect(printsAtCounter(sale({ cashSaleRef: { cashSaleId: 'x' } }), 'cash', true)).toBe(false)
    expect(printsAtCounter(sale({ stockSource: { marker: 'number_clash:x', detectedBy: 'number_clash' } }), 'cash', true)).toBe(false)
    expect(printsAtCounter(sale({ stockSource: { marker: 'stokrazp:x', detectedBy: 'conversion' } }), 'cash', true)).toBe(true)
  })

  it('never an imported document: its first status says so', () => {
    const marks = { statusHistory: [{ reason: 'ocr_import' }, { reason: 'issued' }] }
    expect(isImportedDocument(sale(marks))).toBe(true)
    expect(printsAtCounter(sale(marks), 'cash', true)).toBe(false)
  })

  it('and nothing else says so: not a tag a copy carries, not a document LGR moved itself', () => {
    for (const marks of [
      { tags: ['ocr-import', 'dir:outgoing'] },
      { importedFrom: { kind: 'fenced_export' } },
      { importedFrom: {} },
      { statusHistory: [{ reason: 'created' }, { reason: 'ocr_import' }] },
    ]) {
      expect(isImportedDocument(sale(marks))).toBe(false)
      expect(printsAtCounter(sale(marks), 'cash', true)).toBe(true)
    }
  })
})

describe('the type, as the readers see it', () => {
  it('is numbered in the register\'s series', () => {
    expect(sequenceGroupFor('payment_receipt', 'outgoing')).toBe('cash_sale')
  })

  it('has no sign: the session journal entry and sales history sum none of it', () => {
    expect(posRowSign({ type: 'payment_receipt', status: 'completed' })).toBe(0)
  })

  it('reads back as a row of its own type, and a failed one as cancelled', () => {
    const doc = { _id: 'id', type: 'payment_receipt', status: 'paid', invoiceNumber: 'CS-1', register: { paidInvoiceNumber: 'INV-1', paidInvoiceId: 'i', fiscal: { state: 'printed' } } }
    const row = toPosTransaction(doc)
    expect(row).toMatchObject({ type: 'payment_receipt', status: 'completed', paidInvoiceNumber: 'INV-1' })
    expect(receiptTookMoney(row)).toBe(true)

    const failed = toPosTransaction({ ...doc, status: 'voided', register: { ...doc.register, fiscal: { state: 'failed' } } })
    expect(failed.status).toBe('cancelled')
    expect(receiptTookMoney(failed)).toBe(false)
    expect(receiptTookMoney(toPosTransaction({ ...doc, register: { fiscal: { state: 'pending' } } }))).toBe(false)
    expect(receiptTookMoney(toPosTransaction({ ...doc, register: { fiscal: { state: 'unknown' } } }))).toBe(true)
  })

  it('is immutable', () => {
    expect(isImmutableRegisterDocument({ type: 'payment_receipt' })).toBe(true)
  })
})

describe('what the cash-sale form asks of its session\'s device (D6)', () => {
  it('where LGR prints there is nothing to choose: it asks, whatever the form was left at', () => {
    expect(joinedSaleReceipt({ sessionOpen: true, prints: true, chosen: '' })).toEqual({ receipt: 'fiscal' })
    expect(joinedSaleReceipt({ sessionOpen: true, prints: true, chosen: 'fiscal' })).toEqual({ receipt: 'fiscal' })
  })

  it('where it does not, what the person chose, and by default nothing', () => {
    expect(joinedSaleReceipt({ sessionOpen: true, prints: false, chosen: '' })).toEqual({})
    expect(joinedSaleReceipt({ sessionOpen: true, prints: false, chosen: 'fiscal' })).toEqual({ receipt: 'fiscal' })
  })

  it('with no session there is no device to ask', () => {
    expect(joinedSaleReceipt({ sessionOpen: false, prints: true, chosen: 'fiscal' })).toEqual({})
  })
})

describe('issued, and the receipt did not print', () => {
  it('paid at the counter: unpaid, and Pay takes the money again', () => {
    for (const paymentMethod of ['cash', 'card']) {
      expect(issuedReceiptNotice({ receiptError: 'x', paymentMethod, receipt: { state: 'failed' } }))
        .toEqual({ key: 'cashRegister.receipt.issuedNotPaid', takesPayment: true })
    }
    // Refused on the way to the device: no receipt came of it.
    expect(issuedReceiptNotice({ receiptError: 'x', paymentMethod: 'cash' })).toEqual({ key: 'cashRegister.receipt.issuedNotPaid', takesPayment: true })
  })

  it('a receipt that may have printed stands: the money is recorded, and there is none to take', () => {
    for (const paymentMethod of ['cash', 'card', 'cash_on_delivery']) {
      expect(issuedReceiptNotice({ receiptError: 'x', paymentMethod, receipt: { state: 'unknown' } }))
        .toEqual({ key: 'cashRegister.receipt.issuedUnknown', takesPayment: false })
    }
  })

  it('on delivery the money is the courier\'s: Pay would record what nobody brought', () => {
    expect(issuedReceiptNotice({ receiptError: 'x', paymentMethod: 'cash_on_delivery', receipt: { state: 'failed' } }))
      .toEqual({ key: 'cashRegister.receipt.issuedNoReceipt', takesPayment: false })
  })

  it('nothing went wrong: nothing to say', () => {
    // Printed, with a word of warning: it is paid, so the Pay button is no way on.
    expect(issuedReceiptNotice({ receiptError: 'x', paymentMethod: 'cash', receipt: { state: 'printed' } }))
      .toEqual({ key: 'cashRegister.receipt.issuedUnknown', takesPayment: false })
    expect(issuedReceiptNotice({ paymentMethod: 'cash' })).toBeNull()
    expect(issuedReceiptNotice(null)).toBeNull()
    // A document that changed under its issue: Pay is the way on, but for the courier's money.
    expect(issuedReceiptNotice({ receiptError: 'x', receiptCode: 'issue_tender_moved', paymentMethod: 'bank_transfer', type: 'credit_note' }))
      .toEqual({ key: 'cashRegister.receipt.issuedChangedRefund', takesPayment: true })
    expect(issuedReceiptNotice({ receiptError: 'x', receiptCode: 'issue_tender_moved', paymentMethod: 'cash' }))
      .toEqual({ key: 'cashRegister.receipt.issuedChanged', takesPayment: true })
    expect(issuedReceiptNotice({ receiptError: 'x', receiptCode: 'issue_tender_moved', paymentMethod: 'cash_on_delivery' }))
      .toEqual({ key: 'cashRegister.receipt.issuedChangedDelivery', takesPayment: false })
  })
})

describe('the refusal, in words', () => {
  it('says what to do about a session and a device', () => {
    expect(receiptRefusalKey({ code: 'fiscal_device_not_connected', noSession: true })).toBe('cashRegister.receipt.noSession')
    expect(receiptRefusalKey({ code: 'fiscal_device_not_connected', deviceConfigured: true })).toBe('pos.printerRequired.notConnected')
    expect(receiptRefusalKey({ code: 'fiscal_device_not_connected', deviceConfigured: false })).toBe('pos.printerRequired.notConfigured')
    expect(receiptRefusalKey({ code: 'fiscally_paid' })).toBe('cashRegister.receipt.fiscallyPaid')
    expect(receiptRefusalKey({ code: 'no_receipt_owed' })).toBe('cashRegister.receipt.noneOwed')
    expect(receiptRefusalKey({ code: 'receipt_in_doubt' })).toBe('cashRegister.receipt.inDoubtRefused')
    expect(receiptRefusalKey({ code: 'delivery_receipt_owed' })).toBe('cashRegister.receipt.deliveryOwed')
    expect(receiptRefusalKey({ code: 'receipts_unfinished' })).toBe('cashRegister.receipt.unfinished')
    expect(receiptRefusalParams({ receipt: { number: 'CS-1' } }).number).toBe('CS-1')
    expect(receiptRefusalParams({ receipts: [{ number: 'CS-1' }, { number: null, invoice: 'INV-2' }] }).numbers).toBe('CS-1, INV-2')
    expect(receiptRefusalKey({ code: 'overpayment' })).toBeNull()
    expect(receiptRefusalKey({ code: 'refund_exceeds_paid' })).toBe('cashRegister.receipt.refundExceedsPaid')
    expect(receiptRefusalKey({ code: 'fiscally_paid', note: true })).toBe('cashRegister.receipt.fiscallyPaidNote')
    expect(receiptRefusalKey({ code: 'fiscally_paid' })).toBe('cashRegister.receipt.fiscallyPaid')
    expect(receiptRefusalKey({ code: 'refund_exceeds_receipts' })).toBe('cashRegister.receipt.refundExceeds')
    expect(receiptRefusalKey({ code: 'refund_exceeds_receipts', atIssue: true })).toBe('cashRegister.receipt.refundExceedsAtIssue')
    expect(receiptRefusalKey({ code: 'no_receipt_to_storno', reason: 'none' })).toBe('cashRegister.receipt.noReceiptToStorno')
    expect(receiptRefusalKey({ code: 'no_receipt_to_storno', reason: 'no_number' })).toBe('cashRegister.receipt.noReceiptNumber')
    expect(receiptRefusalKey({ code: 'no_receipt_to_storno', reason: 'other_kind' })).toBe('cashRegister.receipt.noReceiptOfKind')
    expect(receiptRefusalKey({ code: 'fiscally_paid', document: 'CN-1' })).toBe('cashRegister.receipt.fiscallyPaidUnderNote')
    expect(receiptRefusalParams({ code: 'fiscally_paid', document: 'CN-1' } as any).number).toBe('CN-1')
    expect(receiptRefusalKey({ code: 'refund_exceeds_paid', atIssue: true })).toBe('cashRegister.receipt.refundExceedsPaidAtIssue')
  })

  it('every refusal a door answers reads in all four languages: a missing key renders literally', () => {
    const codes = [
      'payment_in_progress', 'document_claimed', 'document_changed', 'issue_in_progress', 'fiscally_paid', 'receipt_currency', 'receipt_not_printable', 'document_not_issued',
      'no_receipt_owed', 'receipt_in_doubt', 'storno_in_doubt', 'receipt_open_on_device', 'receipt_device_away', 'device_busy', 'fiscal_holder_unreachable', 'fiscal_holder_moved', 'storno_in_progress', 'sale_receipt_in_doubt', 'sale_in_progress', 'session_closing',
      'receipt_number_required', 'receipt_number_taken', 'receipt_number_off_device', 'receipt_number_cited', 'delivery_receipt_owed', 'receipts_unfinished', 'close_interrupted',
      'refund_exceeds_paid',
      'storno_exceeds_left', 'storno_exceeds_budget', 'storno_refund_mismatch', 'storno_line_unknown', 'storno_quantity_invalid', 'storno_not_splittable', 'storno_refund_not_positive',
    ]
    const locales = { en, bg, de, mk } as Record<string, any>
    for (const code of codes) {
      const key = receiptRefusalKey({ code })
      expect(key, code).toBeTruthy()
      for (const [name, messages] of Object.entries(locales)) {
        const text = key!.split('.').reduce((at: any, part) => at?.[part], messages)
        expect(typeof text, `${name}: ${key}`).toBe('string')
        expect(text.length, `${name}: ${key}`).toBeGreaterThan(0)
      }
    }
  })

  it('what the close dialog and the sessions page say reads in all four languages too', () => {
    const locales = { en, bg, de, mk } as Record<string, any>
    for (const key of [
      'pos.close.deadSales', 'pos.close.deadSalesBooked', 'pos.close.deadDocuments', 'pos.close.interruptedTitle', 'pos.close.closeAgain', 'pos.sessions.states.closing_control',
      'cashRegister.receipt.correctNumber', 'cashRegister.receipt.correctNumberConfirm', 'cashRegister.receipt.numberCorrected',
      'cashRegister.receipt.slipSaysThisNumber',
      'cashRegister.receipt.issuedChanged', 'cashRegister.receipt.issuedChangedDelivery', 'cashRegister.receipt.issuedChangedRefund',
      'cashRegister.receipt.refundExceedsPaid', 'cashRegister.receipt.refundExceedsPaidAtIssue', 'cashRegister.receipt.issuedPartlyRefunded',
      'cashRegister.receipt.fiscallyPaidUnderNote', 'cashRegister.receipt.noReceiptNumber', 'cashRegister.receipt.noReceiptOfKind',
      'cashRegister.receipt.bringNumber', 'cashRegister.receipt.bringNumberConfirm', 'cashRegister.receipt.refundExceedsAtIssue', 'cashRegister.receipt.fiscallyPaidNote',
      'cashRegister.receipt.listReceipts', 'cashRegister.receipt.listStornos',
    ]) {
      for (const [name, messages] of Object.entries(locales)) {
        const text = key.split('.').reduce((at: any, part) => at?.[part], messages)
        expect(typeof text, `${name}: ${key}`).toBe('string')
      }
    }
  })

  it('a failed print is the one that offers a retry', () => {
    expect(isFailedPrint({ code: 'fiscal_error' })).toBe(true)
    expect(isFailedPrint({ code: 'fiscally_paid' })).toBe(false)
  })

  it('falls back to the server\'s words, then to the caller\'s', () => {
    const t = (k: string) => `t:${k}`
    expect(receiptRefusalMessage(t, { response: { data: { code: 'fiscally_paid', message: 'x' } } }, 'f')).toBe('t:cashRegister.receipt.fiscallyPaid')
    expect(receiptRefusalMessage(t, { response: { data: { message: 'x' } } }, 'f')).toBe('x')
    expect(receiptRefusalMessage(t, {}, 'f')).toBe('f')
  })

  it('a payment is neither of the sale\'s colours', () => {
    expect(kindColor('sale')).toBe('success')
    expect(kindColor('storno')).toBe('error')
    expect(kindColor('payment')).toBe('info')
  })
})
