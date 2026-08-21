import { describe, it, expect } from 'bun:test'
// PURE module — no Vue, importable directly by relative path. `invoicing-ui` is a private
// app package (not a workspace dependency / not symlinked in node_modules), so we reach the
// source file by path rather than by package name. The module has zero runtime imports
// (only `import type`, which bun elides), so this loads cleanly.
import {
  buildPayload,
  buildProductUpdates,
  computeTotals,
  MAX_PRICE_TIERS,
  type DocumentFormState,
} from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'

/**
 * Wire-faithful payload: axios JSON-serialises the body, dropping `undefined`-valued keys.
 * Round-tripping through JSON reproduces exactly what reaches the server, so the expected
 * objects below are written as the wire bytes (omitting undefined, keeping empty strings).
 */
function wire(obj: Record<string, any>): Record<string, any> {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * Expected-payload assumptions encoded here (derived from today's *FormView.vue behaviour):
 *  - Sales invoice uses an explicit whitelist: omits empty notes/terms/footer (→ dropped),
 *    omits `paymentMethod` entirely, includes billingAddress (state dropped when empty),
 *    discountTotal + taxTotal + totalBase, and `accountId` per line. `dueDate || issueDate`.
 *  - The other five spread `...form.value`: empty strings are KEPT (notes:'', paymentMethod:'');
 *    no discountTotal/taxTotal/totalBase; due date is sent as-is (no fallback).
 *  - Credit/Debit/Cash persist BOTH `date` and `issueDate` (same value).
 *  - Cash sale drops empty `contactId` (omit-empty) and emits no due date.
 *  - Proforma emits `validUntil` (not dueDate); Purchase emits `supplierInvoiceNumber`,
 *    direction 'incoming', type 'invoice'.
 *  - Tax/line math: discount-aware for invoice+proforma, plain for the rest; every money
 *    figure rounded with +(x).toFixed(2). Totals: subtotal − discountTotal + taxTotal.
 */

describe('buildPayload — sales invoice', () => {
  const state: DocumentFormState = {
    contactId: 'c1',
    issueDate: '2026-06-01',
    dueDate: '',
    currency: 'EUR',
    exchangeRate: 1,
    notes: 'Thank you',
    terms: '',
    footer: '',
    billingAddress: { street: '1 Main', city: 'Sofia', state: '', postalCode: '1000', country: 'BG' },
    tags: ['vip'],
    lines: [
      { productId: 'p1', description: 'Widget', quantity: 2, unit: 'pcs', unitPrice: 100, discount: 10, taxRate: 20, warehouseId: 'w1' },
      { productId: 'p2', description: 'Gadget', quantity: 1, unit: 'box', unitPrice: 50, discount: 0, taxRate: 20 },
      { description: '', quantity: 1, unit: 'pcs', unitPrice: 0, discount: 0, taxRate: 20 }, // empty → dropped
    ],
  }

  it('produces the legacy sales-invoice body (discount + tax, rounding, dueDate fallback, omit-empty)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.invoice))).toEqual({
      contactId: 'c1',
      type: 'invoice',
      direction: 'outgoing',
      issueDate: '2026-06-01',
      dueDate: '2026-06-01', // fallback to issueDate
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: 'p1', description: 'Widget', quantity: 2, unit: 'pcs', unitPrice: 100, discount: 10, taxRate: 20, taxAmount: 36, lineTotal: 216, warehouseId: 'w1' },
        { productId: 'p2', description: 'Gadget', quantity: 1, unit: 'box', unitPrice: 50, discount: 0, taxRate: 20, taxAmount: 10, lineTotal: 60 },
      ],
      subtotal: 250,
      discountTotal: 20,
      taxTotal: 46,
      total: 276,
      totalBase: 276,
      notes: 'Thank you',
      billingAddress: { street: '1 Main', city: 'Sofia', postalCode: '1000', country: 'BG' },
      tags: ['vip'],
    })
  })

  it('computes totals (discount-aware)', () => {
    const t = computeTotals(state.lines, DOCUMENT_CONFIGS.invoice)
    expect(t.subtotal).toBeCloseTo(250, 6)
    expect(t.discountTotal).toBeCloseTo(20, 6)
    expect(t.taxTotal).toBeCloseTo(46, 6)
    expect(t.total).toBeCloseTo(276, 6)
  })

  it('drops empty lines and never leaks paymentMethod/terms/footer', () => {
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.invoice))
    expect(p.lines).toHaveLength(2)
    expect(p).not.toHaveProperty('paymentMethod')
    expect(p).not.toHaveProperty('terms')
    expect(p).not.toHaveProperty('footer')
    expect(p).not.toHaveProperty('date')
  })
})

describe('buildPayload — purchase invoice', () => {
  const state: DocumentFormState = {
    supplierInvoiceNumber: 'SUP-99',
    contactId: 'c2',
    issueDate: '2026-06-02',
    dueDate: '2026-07-02',
    paymentMethod: 'bank_transfer',
    currency: 'USD',
    exchangeRate: 1.1,
    notes: '',
    tags: [],
    lines: [
      { productId: 'p3', description: 'Bolt', quantity: 3, unit: 'pcs', unitPrice: 10, taxRate: 20, warehouseId: 'w2' },
      { description: '', quantity: 1, unitPrice: 0, taxRate: 20 }, // empty → dropped
    ],
  }

  it('produces the legacy purchase body (incoming/invoice, supplierInvoiceNumber, empty strings kept, no taxTotal)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.purchase_invoice))).toEqual({
      contactId: 'c2',
      type: 'invoice',
      direction: 'incoming',
      supplierInvoiceNumber: 'SUP-99',
      // The supplier's own number is persisted in `reference` — that is the field the model
      // has and the Bills list renders. `supplierInvoiceNumber` alone was silently dropped.
      reference: 'SUP-99',
      issueDate: '2026-06-02',
      dueDate: '2026-07-02',
      paymentMethod: 'bank_transfer',
      currency: 'USD',
      exchangeRate: 1.1,
      lines: [
        { productId: 'p3', description: 'Bolt', quantity: 3, unit: 'pcs', unitPrice: 10, taxRate: 20, taxAmount: 6, lineTotal: 36, warehouseId: 'w2' },
      ],
      subtotal: 30,
      total: 36,
      notes: '',
      tags: [],
    })
  })

  it('mirrors the supplier invoice number onto `reference` so it actually persists', () => {
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.purchase_invoice))
    expect(p.reference).toBe('SUP-99')
    // Sales documents have no supplier number and must not gain a stray `reference`.
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.invoice))).not.toHaveProperty('reference')
  })

  it('keeps empty notes (spread style) and omits discount/totalBase', () => {
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.purchase_invoice))
    expect(p.notes).toBe('')
    expect(p).not.toHaveProperty('discountTotal')
    expect(p).not.toHaveProperty('taxTotal')
    expect(p).not.toHaveProperty('totalBase')
    expect(p.lines[0]).not.toHaveProperty('discount')
    expect(p.lines[0]).not.toHaveProperty('accountId')
  })
})

describe('buildPayload — proforma', () => {
  const state: DocumentFormState = {
    contactId: 'c3',
    issueDate: '2026-06-03',
    validUntil: '2026-07-03',
    paymentMethod: '',
    currency: 'EUR',
    exchangeRate: 1,
    notes: 'Quote',
    terms: 'Net 30',
    tags: ['q'],
    lines: [
      { productId: 'p4', description: 'Service', quantity: 2, unit: 'hr', unitPrice: 100, discount: 25, taxRate: 20 },
      { description: '', quantity: 1, unitPrice: 0, discount: 0, taxRate: 20 }, // empty → dropped
    ],
  }

  it('produces the legacy proforma body (validUntil, discount line, no dueDate, empty paymentMethod kept)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.proforma))).toEqual({
      contactId: 'c3',
      type: 'proforma',
      direction: 'outgoing',
      issueDate: '2026-06-03',
      validUntil: '2026-07-03',
      paymentMethod: '',
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: 'p4', description: 'Service', quantity: 2, unit: 'hr', unitPrice: 100, discount: 25, taxRate: 20, taxAmount: 30, lineTotal: 180 },
      ],
      subtotal: 200,
      total: 180,
      notes: 'Quote',
      terms: 'Net 30',
      tags: ['q'],
    })
  })

  it('has a discount line but never emits discountTotal/dueDate/date', () => {
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.proforma))
    expect(p.lines[0].discount).toBe(25)
    expect(p).not.toHaveProperty('discountTotal')
    expect(p).not.toHaveProperty('dueDate')
    expect(p).not.toHaveProperty('date')
  })
})

describe('buildPayload — credit note', () => {
  const state: DocumentFormState = {
    contactId: 'c4',
    relatedInvoiceId: 'inv1',
    issueDate: '2026-06-04',
    dueDate: '2026-07-04',
    paymentMethod: 'cash',
    currency: 'EUR',
    exchangeRate: 1,
    reason: 'Return',
    tags: [],
    lines: [
      { productId: 'p5', description: 'Refund item', quantity: 1, unit: 'pcs', unitPrice: 80, taxRate: 20, warehouseId: 'w3' },
    ],
  }

  it('produces the legacy credit-note body (relatedInvoiceId, both date + issueDate, reason)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.credit_note))).toEqual({
      contactId: 'c4',
      type: 'credit_note',
      direction: 'outgoing',
      relatedInvoiceId: 'inv1',
      date: '2026-06-04',
      issueDate: '2026-06-04',
      dueDate: '2026-07-04',
      paymentMethod: 'cash',
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: 'p5', description: 'Refund item', quantity: 1, unit: 'pcs', unitPrice: 80, taxRate: 20, taxAmount: 16, lineTotal: 96, warehouseId: 'w3' },
      ],
      subtotal: 80,
      total: 96,
      reason: 'Return',
      tags: [],
    })
  })
})

describe('buildPayload — debit note', () => {
  const state: DocumentFormState = {
    contactId: 'c5',
    relatedInvoiceId: 'inv2',
    issueDate: '2026-06-05',
    dueDate: '2026-07-05',
    paymentMethod: 'card',
    currency: 'EUR',
    exchangeRate: 1,
    reason: 'Extra charge',
    tags: ['adj'],
    lines: [
      { productId: 'p7', description: 'Surcharge', quantity: 2, unit: 'pcs', unitPrice: 25, taxRate: 20 },
    ],
  }

  it('produces the legacy debit-note body (type debit_note, relatedInvoiceId, reason)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.debit_note))).toEqual({
      contactId: 'c5',
      type: 'debit_note',
      direction: 'outgoing',
      relatedInvoiceId: 'inv2',
      date: '2026-06-05',
      issueDate: '2026-06-05',
      dueDate: '2026-07-05',
      paymentMethod: 'card',
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: 'p7', description: 'Surcharge', quantity: 2, unit: 'pcs', unitPrice: 25, taxRate: 20, taxAmount: 10, lineTotal: 60 },
      ],
      subtotal: 50,
      total: 60,
      reason: 'Extra charge',
      tags: ['adj'],
    })
  })
})

describe('buildPayload — cash sale', () => {
  const state: DocumentFormState = {
    contactId: '',
    issueDate: '2026-06-06',
    paymentMethod: 'cash',
    currency: 'EUR',
    exchangeRate: 1,
    notes: 'Walk-in',
    tags: [],
    lines: [
      { productId: 'p6', description: 'Coffee', quantity: 2, unit: 'pcs', unitPrice: 3, taxRate: 20, warehouseId: 'w4' },
    ],
  }

  it('produces the legacy cash-sale body (omit empty contactId, both date + issueDate, no dueDate, decimal rounding)', () => {
    expect(wire(buildPayload(state, DOCUMENT_CONFIGS.cash_sale))).toEqual({
      type: 'cash_sale',
      direction: 'outgoing',
      date: '2026-06-06',
      issueDate: '2026-06-06',
      paymentMethod: 'cash',
      currency: 'EUR',
      exchangeRate: 1,
      lines: [
        { productId: 'p6', description: 'Coffee', quantity: 2, unit: 'pcs', unitPrice: 3, taxRate: 20, taxAmount: 1.2, lineTotal: 7.2, warehouseId: 'w4' },
      ],
      subtotal: 6,
      total: 7.2,
      notes: 'Walk-in',
      tags: [],
    })
  })

  it('drops empty contactId and never emits a due date', () => {
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.cash_sale))
    expect(p).not.toHaveProperty('contactId')
    expect(p).not.toHaveProperty('dueDate')
    // a present contactId is kept
    const p2 = wire(buildPayload({ ...state, contactId: 'cx' }, DOCUMENT_CONFIGS.cash_sale))
    expect(p2.contactId).toBe('cx')
  })
})

describe('filledLines — free-text lines count', () => {
  it('includes product-less lines that carry a description (OCR imports) and keeps totals exact', () => {
    const state: DocumentFormState = {
      contactId: 'c1',
      issueDate: '2026-07-22',
      dueDate: '2026-08-21',
      currency: 'EUR',
      exchangeRate: 1,
      notes: '',
      terms: '',
      footer: '',
      billingAddress: { street: '-', city: '-', state: '', postalCode: '-', country: 'BG' },
      tags: [],
      lines: [
        { productId: 'p1', description: 'ВИНТ 4Х30', quantity: 5000, unit: 'pcs', unitPrice: 0.0071, discount: 0, taxRate: 20 },
        // Free-text line (no catalog match) — must count toward totals and persist.
        { description: 'МОЛИВ ДЪРВОДЕЛСКИ', quantity: 10, unit: 'pcs', unitPrice: 0.148, discount: 0, taxRate: 20 },
        // True placeholder (no product, no description) — dropped.
        { description: '', quantity: 1, unit: 'pcs', unitPrice: 0, discount: 0, taxRate: 20 },
      ],
    }
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.invoice))
    expect(p.lines).toHaveLength(2)
    expect(p.lines[1].description).toBe('МОЛИВ ДЪРВОДЕЛСКИ')
    expect(p.lines[1]).not.toHaveProperty('productId')
    expect(p.subtotal).toBe(36.98) // 35.50 + 1.48
  })
})

describe('buildProductUpdates — purchase bill with-product-update', () => {
  it('returns [] when no line has staged changes', () => {
    expect(buildProductUpdates([
      { productId: 'p1', quantity: 1, unitPrice: 10, productUpdate: {}, priceTiers: [] },
      { description: 'placeholder', quantity: 1, unitPrice: 0 }, // no productId → skipped
    ])).toEqual([])
  })

  it('emits staged fields, skipping empty-string/undefined values and productId-less lines', () => {
    expect(buildProductUpdates([
      { productId: 'p1', quantity: 1, unitPrice: 10, productUpdate: { purchasePrice: 55, sellingPrice: undefined, unit: '' } },
      { quantity: 1, unitPrice: 5, productUpdate: { purchasePrice: 99 } }, // no productId → skipped
    ])).toEqual([{ productId: 'p1', purchasePrice: 55 }])
  })

  it('attaches priceTiers only when touched, normalised and capped at the model limit', () => {
    const untouched = buildProductUpdates([
      { productId: 'p1', quantity: 1, unitPrice: 10, productUpdate: {}, priceTiers: [{ name: 'Price 1', percent: 0, finalPrice: 0, manualOverride: false }] },
    ])
    expect(untouched).toEqual([])

    // The cap is the Product model's validator (Доставна цена + Цена на едро + Цена 0..10).
    // It used to be 10 here, which silently dropped Цена 8/9/10 on every goods receipt.
    expect(MAX_PRICE_TIERS).toBe(13)
    const tiers = Array.from({ length: MAX_PRICE_TIERS + 2 }, (_, i) => ({ name: `P${i + 1}`, percent: i, finalPrice: 100 + i, manualOverride: i === 0 }))
    const out = buildProductUpdates([
      { productId: 'p1', quantity: 1, unitPrice: 10, productUpdate: {}, priceTiers: tiers },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].productId).toBe('p1')
    expect(out[0].priceTiers).toHaveLength(MAX_PRICE_TIERS)
    expect(out[0].priceTiers[0]).toEqual({ name: 'P1', percent: 0, finalPrice: 100, manualOverride: true, contactIds: [], tags: [] })
  })

  it('does not leak staged fields into buildPayload lines (whitelist unchanged)', () => {
    const state: DocumentFormState = {
      contactId: 'c1',
      supplierInvoiceNumber: 'S-1',
      issueDate: '2026-06-01',
      dueDate: '2026-07-01',
      paymentMethod: '',
      currency: 'EUR',
      exchangeRate: 1,
      notes: '',
      tags: [],
      lines: [
        { productId: 'p1', description: 'Part', quantity: 1, unit: 'pcs', unitPrice: 10, taxRate: 20, productUpdate: { purchasePrice: 10 }, priceTiers: [{ name: 'Price 1', finalPrice: 12, manualOverride: true }] },
      ],
    }
    const p = wire(buildPayload(state, DOCUMENT_CONFIGS.purchase_invoice))
    expect(p.lines[0]).not.toHaveProperty('productUpdate')
    expect(p.lines[0]).not.toHaveProperty('priceTiers')
    expect(p).not.toHaveProperty('productUpdates') // buildPayload itself never adds it; the composable does
  })
})
