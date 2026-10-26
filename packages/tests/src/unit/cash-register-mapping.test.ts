import { describe, it, expect } from 'bun:test'
import {
  fromPosTransaction, toPosTransaction, exchangeRateFor, operatorCodeOfUnp,
  CashRegisterMappingError, BGN_PER_EUR,
} from 'services/biz/cash-register/mapping'

/**
 * FR-21 — a POS transaction and the cash-register document it becomes, both ways. The R2 copy
 * writes `fromPosTransaction`; the readers that still speak POS rows read `toPosTransaction`.
 * The round trip gives the row back, except that a line's net comes back rounded to the cent.
 */

const at = new Date('2026-10-21T11:00:00.000Z')
const later = new Date('2026-10-21T12:00:00.000Z')
const session = { _id: 'S1', currency: 'EUR', warehouseId: 'W1', cashierId: 'U1' }

function sale(over: Record<string, any> = {}) {
  return {
    _id: 'T1', orgId: 'O1', sessionId: 'S1', transactionNumber: 'TXN-2026-0000001',
    type: 'sale', status: 'completed', customerId: 'C1',
    lines: [{ productId: 'P1', name: 'Bolt M8', quantity: 3, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 6, lineTotal: 30 }],
    subtotal: 30, discountTotal: 0, taxTotal: 6, total: 36,
    payments: [{ method: 'cash', amount: 50 }], changeDue: 14,
    movementId: 'M1',
    unpNumber: 'ED399266-0001-0000042', fiscalReceiptNumber: '0000117', fiscalDeviceNumber: 'ED399266',
    printedAt: at, isFiscal: true,
    fiscal: { state: 'printed', mode: 'fiscal', receiptNo: '0000117', printedAt: at },
    clientKey: 'key-0001', requestHash: 'h1', completedAt: at, sessionTotalsApplied: true,
    createdBy: 'U1', createdAt: at, updatedAt: at,
    ...over,
  }
}

describe('fromPosTransaction', () => {
  it('a sale becomes a paid cash_sale with the register block', () => {
    const doc = fromPosTransaction(sale(), session, { baseCurrency: 'EUR', unitOf: () => 'бр.' })
    expect(doc).toMatchObject({
      _id: 'T1', invoiceNumber: 'TXN-2026-0000001', type: 'cash_sale', direction: 'outgoing', status: 'paid',
      contactId: 'C1', issueDate: at, currency: 'EUR', exchangeRate: 1, total: 36, totalBase: 36,
      amountPaid: 36, amountDue: 0, paymentMethod: 'cash', clientKey: 'key-0001', requestHash: 'h1',
    })
    expect(doc.register).toMatchObject({
      origin: 'pos', sessionId: 'S1', warehouseId: 'W1', cashierId: 'U1', unp: 'ED399266-0001-0000042',
      operatorCode: '0001', fiscalReceiptNumber: '0000117', isFiscal: true, changeDue: 14, movementId: 'M1',
      stornoState: 'none', legacy: { source: 'postransactions', type: 'sale', transactionNumber: 'TXN-2026-0000001' },
    })
    // The line goes gross; it takes the session's warehouse.
    expect(doc.lines[0]).toMatchObject({ description: 'Bolt M8', unit: 'бр.', lineTotal: 36, taxAmount: 6, warehouseId: 'W1' })
    // The payment is what the drawer kept; what was handed over stays on it.
    expect(doc.payments).toEqual([{ date: at, method: 'cash', amount: 36, tendered: 50 }])
  })

  it('a stornoed sale stays paid and is marked; its storno points at it', () => {
    const original = fromPosTransaction(sale({ status: 'cancelled', updatedAt: later }), session, { stornoedBy: ['T2'] })
    expect(original.status).toBe('paid')
    expect(original.register).toMatchObject({ stornoState: 'full', stornoedBy: ['T2'], cancelledAt: later })

    const storno = fromPosTransaction(sale({
      _id: 'T2', transactionNumber: 'TXN-2026-0000002', type: 'storno', changeDue: 0, payments: [{ method: 'cash', amount: 36 }],
      originalTransactionId: 'T1', originalUNP: 'ED399266-0001-0000042', originalFiscalReceiptNumber: '0000117',
      originalTransactionDate: at, stornoReason: 'customer_return',
    }), session)
    expect(storno).toMatchObject({ type: 'cash_storno', status: 'paid', relatedInvoiceId: 'T1', total: 36 })
    expect(storno.register.storno).toEqual({
      originalId: 'T1', originalUnp: 'ED399266-0001-0000042', originalReceiptNumber: '0000117', originalDate: at, reason: 'customer_return',
    })
  })

  it('a storno whose receipt failed is voided, and keeps no payment', () => {
    const doc = fromPosTransaction(sale({ type: 'storno', status: 'cancelled', updatedAt: later }), session)
    expect(doc.status).toBe('voided')
    expect(doc.payments).toEqual([])
    expect(doc.amountPaid).toBe(0)
    expect(doc.register.cancelledAt).toEqual(later)
  })

  it('split tender: the change comes off the cash part', () => {
    const doc = fromPosTransaction(sale({ payments: [{ method: 'card', amount: 20 }, { method: 'cash', amount: 30 }], changeDue: 14 }), session)
    expect(doc.payments).toEqual([
      { date: at, method: 'card', amount: 20 },
      { date: at, method: 'cash', amount: 16, tendered: 30 },
    ])
    expect(doc.paymentMethod).toBeUndefined()
  })

  it("a storno carrying the sale's payments refunds what the sale kept, not what was handed over", () => {
    // #145: a storno row copies the SALE's tendered payments and has no change of its own.
    const doc = fromPosTransaction(sale({ type: 'storno', changeDue: 0, originalTransactionId: 'T0' }), session)
    expect(doc.payments).toEqual([{ date: at, method: 'cash', amount: 36, tendered: 50 }])
    expect(doc.payments.reduce((s: number, p: any) => s + p.amount, 0)).toBe(doc.total)
    // And it reads back as the row it was.
    expect(toPosTransaction(doc).payments).toEqual([{ method: 'cash', amount: 50 }])
  })

  it('refuses a return or exchange, and a currency it has no rate for', () => {
    expect(() => fromPosTransaction(sale({ type: 'return' }), session)).toThrow(CashRegisterMappingError)
    expect(() => fromPosTransaction(sale(), { ...session, currency: 'USD' }, { baseCurrency: 'EUR' })).toThrow(CashRegisterMappingError)
  })

  it('a BGN session in an EUR org: the rate is the base value of one lev', () => {
    const doc = fromPosTransaction(sale(), { ...session, currency: 'BGN' }, { baseCurrency: 'EUR' })
    expect(doc.currency).toBe('BGN')
    expect(doc.exchangeRate).toBeCloseTo(1 / BGN_PER_EUR, 10)
    expect(doc.totalBase).toBe(18.41)
  })

  it('writes no undefined value, nested or in a line', () => {
    const doc = fromPosTransaction(sale({ customerId: undefined, movementId: undefined }), { currency: 'EUR' })
    const walk = (v: any): boolean => v === undefined || (v && typeof v === 'object' && !(v instanceof Date) && Object.values(v).some(walk))
    expect(walk(doc)).toBe(false)
  })
})

describe('the round trip', () => {
  const shapes: Record<string, any> = {
    'a fiscal sale with change': sale(),
    'a text-mode sale': sale({ isFiscal: false, unpNumber: undefined, fiscalReceiptNumber: undefined, fiscal: { state: 'printed', mode: 'text' } }),
    'a sale whose print failed': sale({ fiscal: { state: 'failed', mode: 'fiscal', error: 'NAK' }, receiptError: 'NAK', fiscalReceiptNumber: undefined }),
    'a stornoed sale': sale({ status: 'cancelled', updatedAt: later }),
    'a storno': sale({ type: 'storno', changeDue: 0, payments: [{ method: 'card', amount: 36 }], originalTransactionId: 'T0', originalUNP: 'X', stornoReason: 'operator_error' }),
    'a voided storno': sale({ type: 'storno', status: 'cancelled', changeDue: 0, updatedAt: later }),
    'a sale with a stock error': sale({ movementId: undefined, stockError: 'no stock' }),
    'mobile and voucher': sale({ payments: [{ method: 'mobile', amount: 20 }, { method: 'voucher', amount: 16 }], changeDue: 0 }),
  }
  for (const [name, row] of Object.entries(shapes)) {
    it(`gives the row back: ${name}`, () => {
      const back = toPosTransaction(fromPosTransaction(row, session))
      const { currency, ...rest } = back
      expect(currency).toBe('EUR')
      // A voided storno keeps no payment as a document.
      const expected: any = { ...row, payments: row.type === 'storno' && row.status === 'cancelled' ? [] : row.payments }
      for (const k of Object.keys(expected)) if (expected[k] === undefined) delete expected[k]
      expect(rest).toEqual(expected)
    })
  }
})

describe('helpers', () => {
  it('exchangeRateFor: base-currency value of one unit', () => {
    expect(exchangeRateFor('EUR', 'EUR')).toBe(1)
    expect(exchangeRateFor('EUR', 'BGN')).toBe(BGN_PER_EUR)
    expect(exchangeRateFor('BGN', 'EUR')).toBeCloseTo(0.511292, 6)
    expect(exchangeRateFor('USD', 'EUR')).toBeNull()
  })

  it('operatorCodeOfUnp', () => {
    expect(operatorCodeOfUnp('ED399266-0007-0000042')).toBe('0007')
    expect(operatorCodeOfUnp('garbage')).toBeUndefined()
  })
})
