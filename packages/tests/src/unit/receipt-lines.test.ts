import { describe, it, expect } from 'bun:test'
import {
  apportion, documentText, fiscalUnitPrice, grossByRate, movesPrintedMoney, paymentText, printsExactly, receiptBody, receiptedByRate, splitByRate,
} from 'services/biz/cash-register/receipt-lines'
import { receiptRefusalKey, receiptRefusalMessage, receiptRefusalParams, isFailedPrint } from 'ui-shared/cash-register/receipt-refusal'
import { kindColor } from 'ui-shared/cash-register/journal-kind'
import { issuedReceiptNotice } from '../../../invoicing-ui/src/composables/document-issue'
import { isImportedDocument, printsAtCounter } from 'services/biz/cash-register/payment-receipt.service'
import { isImmutableRegisterDocument } from 'services/biz/cash-register/immutability'
import { sequenceGroupFor } from 'services/biz/sequence-registry'
import { posRowSign, receiptTookMoney } from 'services/biz/cash-register/counting'
import { toPosTransaction } from 'services/biz/cash-register/mapping'

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

  it('a device takes no quantity or price below zero, nor a 100 % discount', () => {
    const lines = [{ quantity: -1, unitPrice: 10, taxRate: 20, lineTotal: 12 }]
    expect(printsExactly(doc(lines, 12), [{ rate: 20, gross: 12 }])).toBe(false)
    const free = [{ quantity: 1, unitPrice: 10, discount: 100, taxRate: 20, lineTotal: 0 }]
    expect(printsExactly(doc(free, 0), [{ rate: 20, gross: 0 }])).toBe(false)
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
