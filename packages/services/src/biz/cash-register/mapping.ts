/**
 * FR-21 — a POS transaction and the cash-register document it becomes, both ways.
 *
 * A cash-register document is an `Invoice` of type `cash_sale` or `cash_storno` with a `register`
 * block (D-1..D-3). A POS transaction maps onto one field for field, and back:
 * - `fromPosTransaction` is what the R2 copy (`0005`-style migration) and a restore of an older
 *   bundle write;
 * - `toPosTransaction` is how the readers that still speak POS rows — SUPTO 18.1–18.5, the session
 *   journal entry, `/trade/pos/transactions` — read a document while both stores exist (FR-21.8).
 *
 * Round trip: `toPosTransaction(fromPosTransaction(x))` gives `x` back, except that a line's net
 * value comes back rounded to the cent (the document keeps the gross, `lineTotal`).
 *
 * Import-pure: plain objects in, plain objects out; ids pass through untouched.
 */

/** The fixed lev-euro conversion rate (BGN per EUR). */
export const BGN_PER_EUR = 1.95583

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/**
 * The base-currency value of one unit of `currency` — how `Invoice.exchangeRate` is read
 * everywhere (`totalBase = total × exchangeRate`, a journal line's base amount likewise). `null`
 * when no rate is known: the copy refuses that row rather than guess.
 */
export function exchangeRateFor(currency: string | undefined, baseCurrency: string | undefined): number | null {
  const doc = (currency || 'EUR').toUpperCase()
  const base = (baseCurrency || 'EUR').toUpperCase()
  if (doc === base) return 1
  if (doc === 'EUR' && base === 'BGN') return BGN_PER_EUR
  if (doc === 'BGN' && base === 'EUR') return 1 / BGN_PER_EUR
  return null
}

/** `DDDDDDDD-OOOO-NNNNNNN` → `OOOO`, the operator a УНП names. */
export function operatorCodeOfUnp(unp: string | undefined): string | undefined {
  const m = /^[A-Za-z0-9]{8}-(\d{4})-\d{7}$/.exec(unp || '')
  return m ? m[1] : undefined
}

export interface PosSessionInfo {
  _id?: unknown
  currency?: string
  warehouseId?: unknown
  cashierId?: unknown
}

export interface FromPosOptions {
  /** The org's base currency, for `exchangeRate`. */
  baseCurrency?: string
  /** A line's unit, by product id; the POS line carries none. */
  unitOf?: (productId: unknown) => string | undefined
  /** The storno documents that reverse this sale, when it is one that was stornoed. */
  stornoedBy?: unknown[]
}

export class CashRegisterMappingError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

/** What a POS row's `type` becomes. `return` / `exchange` have no storno semantics: refused. */
function documentType(row: any): 'cash_sale' | 'cash_storno' {
  if (row.type === 'sale') return 'cash_sale'
  if (row.type === 'storno') return 'cash_storno'
  throw new CashRegisterMappingError('pos_type_unmapped', `POS transaction ${row.transactionNumber} is a "${row.type}", which has no cash-register equivalent`)
}

/**
 * The money kept per payment, so that `Σ payments.amount = total` holds for every reader (§3.2).
 * What was handed over beyond the total comes off the cash payments, last first, which is where
 * change is handed back from. What was tendered stays on the payment as `tendered` when it differs.
 *
 * The excess is read from the row's own payments, not from `changeDue`: a storno row carries the
 * SALE's payments and no change of its own (#145), so a storno of a 24.00 sale paid with 30.00 in
 * cash holds 30.00 and `changeDue: 0`. Its refund is 24.00.
 */
function keptPayments(row: any, date: Date) {
  const payments: any[] = (row.payments || []).map((p: any) => ({ ...p }))
  const handed = payments.reduce((s, p) => s + (Number(p.amount) || 0), 0)
  let change = round2(Math.max(0, handed - (Number(row.total) || 0)))
  for (let i = payments.length - 1; i >= 0 && change > 0; i--) {
    if (payments[i].method !== 'cash') continue
    const take = Math.min(change, Number(payments[i].amount) || 0)
    payments[i].tendered = payments[i].amount
    payments[i].amount = round2((Number(payments[i].amount) || 0) - take)
    change = round2(change - take)
  }
  return payments.map(p => ({
    date,
    method: p.method,
    amount: round2(p.amount),
    ...(p.tendered !== undefined && round2(p.tendered) !== round2(p.amount) ? { tendered: round2(p.tendered) } : {}),
    ...(p.reference ? { reference: p.reference } : {}),
  }))
}

/** A POS transaction as a cash-register document (`Invoice` shape, ready to insert raw). */
export function fromPosTransaction(row: any, session: PosSessionInfo | null | undefined, opts: FromPosOptions = {}): Record<string, any> {
  const type = documentType(row)
  const currency = session?.currency || 'EUR'
  const exchangeRate = exchangeRateFor(currency, opts.baseCurrency)
  if (exchangeRate === null) {
    throw new CashRegisterMappingError('currency_unmapped', `POS transaction ${row.transactionNumber}: no rate from ${currency} to ${opts.baseCurrency}`)
  }
  const createdAt: Date = row.createdAt
  const cancelled = row.status === 'cancelled'
  // A storno whose receipt failed reversed nothing (#145); a sale is cancelled only by its storno.
  const status = cancelled && type === 'cash_storno' ? 'voided' : 'paid'
  const payments = keptPayments(row, createdAt)
  const methods = [...new Set(payments.map(p => p.method))]

  const doc: Record<string, any> = {
    _id: row._id,
    orgId: row.orgId,
    invoiceNumber: row.transactionNumber,
    type,
    direction: 'outgoing',
    status,
    statusHistory: [{ status, changedAt: createdAt, changedBy: row.createdBy, reason: 'migrated_from_pos' }],
    numberHistory: [{ number: row.transactionNumber, allocatedAt: createdAt, status }],
    contactId: row.customerId,
    issueDate: createdAt,
    dueDate: createdAt,
    currency,
    exchangeRate,
    lines: (row.lines || []).map((l: any) => ({
      productId: l.productId,
      description: l.name,
      quantity: l.quantity,
      unit: opts.unitOf?.(l.productId) || 'бр.',
      unitPrice: l.unitPrice,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: l.taxAmount || 0,
      // Gross, the Invoice convention (FR-21.5); a POS line keeps the net.
      lineTotal: round2((Number(l.lineTotal) || 0) + (Number(l.taxAmount) || 0)),
      warehouseId: session?.warehouseId,
      ...(l.priceExplanation?.length ? { priceExplanation: l.priceExplanation } : {}),
    })),
    subtotal: row.subtotal,
    discountTotal: row.discountTotal || 0,
    taxTotal: row.taxTotal || 0,
    total: row.total,
    totalBase: round2((Number(row.total) || 0) * exchangeRate),
    amountPaid: status === 'paid' ? row.total : 0,
    amountDue: 0,
    payments: status === 'paid' ? payments : [],
    ...(methods.length === 1 ? { paymentMethod: methods[0] } : {}),
    ...(status === 'paid' ? { paidAt: createdAt } : {}),
    ...(type === 'cash_storno' && row.originalTransactionId ? { relatedInvoiceId: row.originalTransactionId } : {}),
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    attachments: [],
    ...(row.clientKey ? { clientKey: row.clientKey, requestHash: row.requestHash } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    register: {
      origin: 'pos',
      sessionId: row.sessionId,
      warehouseId: session?.warehouseId,
      cashierId: session?.cashierId,
      fiscalDeviceNumber: row.fiscalDeviceNumber,
      operatorCode: operatorCodeOfUnp(row.unpNumber),
      unp: row.unpNumber,
      fiscalReceiptNumber: row.fiscalReceiptNumber,
      printedAt: row.printedAt,
      isFiscal: !!row.isFiscal,
      ...(row.fiscal ? { fiscal: row.fiscal } : {}),
      changeDue: row.changeDue || 0,
      sessionTotalsApplied: row.sessionTotalsApplied,
      receiptError: row.receiptError,
      stockError: row.stockError,
      movementId: row.movementId,
      ...(type === 'cash_storno'
        ? {
            storno: {
              originalId: row.originalTransactionId,
              originalUnp: row.originalUNP,
              originalReceiptNumber: row.originalFiscalReceiptNumber,
              originalDate: row.originalTransactionDate,
              reason: row.stornoReason,
            },
          }
        : {}),
      // The sale a storno reversed: still counted (FR-21.1), and marked.
      ...(type === 'cash_sale' && cancelled
        ? { stornoState: 'full', stornoedBy: opts.stornoedBy || [], cancelledAt: row.updatedAt }
        : type === 'cash_sale' ? { stornoState: 'none' } : {}),
      ...(type === 'cash_storno' && cancelled ? { cancelledAt: row.updatedAt } : {}),
      legacy: { source: 'postransactions', type: row.type, transactionNumber: row.transactionNumber },
    },
    createdBy: row.createdBy,
    createdAt,
    updatedAt: row.updatedAt,
  }
  // No undefined values in a raw insert: the driver would write them as nulls.
  dropUndefined(doc)
  return doc
}

/**
 * A cash-register document as the POS row it was or stands for — for the readers that still speak
 * POS rows while both stores exist. Only meaningful for `register.origin: 'pos'` documents.
 */
export function toPosTransaction(doc: any): Record<string, any> {
  const reg = doc.register || {}
  const isStorno = doc.type === 'cash_storno'
  const cancelled = doc.status === 'voided' || (!isStorno && reg.stornoState === 'full')
  const row: Record<string, any> = {
    _id: doc._id,
    orgId: doc.orgId,
    sessionId: reg.sessionId,
    transactionNumber: doc.invoiceNumber,
    type: reg.legacy?.type || (isStorno ? 'storno' : 'sale'),
    status: cancelled ? 'cancelled' : 'completed',
    customerId: doc.contactId,
    lines: (doc.lines || []).map((l: any) => ({
      productId: l.productId,
      name: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: l.taxAmount || 0,
      lineTotal: round2((Number(l.lineTotal) || 0) - (Number(l.taxAmount) || 0)),
      ...(l.priceExplanation?.length ? { priceExplanation: l.priceExplanation } : {}),
    })),
    subtotal: doc.subtotal,
    discountTotal: doc.discountTotal || 0,
    taxTotal: doc.taxTotal || 0,
    total: doc.total,
    // What the customer handed over, as the POS row recorded it.
    payments: (doc.payments || []).map((p: any) => ({
      method: p.method,
      amount: p.tendered ?? p.amount,
      ...(p.reference ? { reference: p.reference } : {}),
    })),
    changeDue: reg.changeDue || 0,
    movementId: reg.movementId,
    unpNumber: reg.unp,
    fiscalReceiptNumber: reg.fiscalReceiptNumber,
    fiscalDeviceNumber: reg.fiscalDeviceNumber,
    printedAt: reg.printedAt,
    isFiscal: !!reg.isFiscal,
    fiscal: reg.fiscal,
    ...(isStorno
      ? {
          originalTransactionId: reg.storno?.originalId ?? doc.relatedInvoiceId,
          originalUNP: reg.storno?.originalUnp,
          originalFiscalReceiptNumber: reg.storno?.originalReceiptNumber,
          originalTransactionDate: reg.storno?.originalDate,
          stornoReason: reg.storno?.reason,
        }
      : {}),
    clientKey: doc.clientKey,
    requestHash: doc.requestHash,
    completedAt: doc.completedAt,
    sessionTotalsApplied: reg.sessionTotalsApplied,
    receiptError: reg.receiptError,
    stockError: reg.stockError,
    createdBy: doc.createdBy,
    createdAt: doc.createdAt,
    // SUPTO 18.5 prints `updatedAt` as the moment a sale was cancelled.
    updatedAt: reg.cancelledAt ?? doc.updatedAt,
    // Not on a POS row (it lives on the session); kept for the readers that report a currency.
    currency: doc.currency,
  }
  dropUndefined(row)
  return row
}

const isPlain = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype

/** Remove undefined values from plain objects, nested ones and those inside arrays (ids untouched). */
function dropUndefined(o: Record<string, any>) {
  for (const k of Object.keys(o)) {
    const v = o[k]
    if (v === undefined) delete o[k]
    else if (isPlain(v)) dropUndefined(v)
    else if (Array.isArray(v)) for (const item of v) if (isPlain(item)) dropUndefined(item)
  }
}
