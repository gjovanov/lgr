/**
 * PURE payload + totals math for invoicing documents.
 *
 * No Vue, no I/O, no app store — every input is a plain object. This is the
 * correctness-critical core of the unified document form and is unit-tested in
 * isolation (`packages/tests/src/unit/document-payload.test.ts`).
 *
 * Parity contract: for each of the six document types, `buildPayload` reproduces the
 * exact object the legacy *FormView.vue `handleSubmit`/`buildPayload` produced — same
 * keys, same `+(x).toFixed(2)` rounding, same `dueDate || issueDate` fallback, and the
 * same omit-when-empty behaviour (empty optional fields become `undefined`, which axios
 * drops on JSON serialisation; the spread-style forms instead keep empty strings).
 *
 * The totals use one discount-aware formula. For the non-discount document types the
 * line math branches to the legacy non-discount expressions so the rounded results are
 * byte-identical (discount defaults to 0 either way).
 */

import type { DocumentTypeConfig } from './types'

export interface PriceStep {
  type: string
  label: string
  price: number
}

export interface LineInput {
  productId?: string
  description?: string
  quantity?: number
  unit?: string
  unitPrice?: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal?: number
  accountId?: string
  warehouseId?: string
  priceExplanation?: PriceStep[]
  resolvedPrice?: number
  /** Purchase bills with-product-update: staged product-master field edits. */
  productUpdate?: Record<string, any>
  /** Purchase bills with-product-update: staged priceTiers snapshot (≤10 slots). */
  priceTiers?: Array<{ name: string; percent?: number; finalPrice?: number; manualOverride?: boolean; contactIds?: string[]; tags?: string[] }>
}

export interface BillingAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

/** Canonical (normalised) form state owned by `useDocumentForm`. The `form.date` vs
 *  `form.issueDate` split of the legacy forms is collapsed onto `issueDate`. */
export interface DocumentFormState {
  contactId?: string
  supplierInvoiceNumber?: string
  relatedInvoiceId?: string
  issueDate?: string
  dueDate?: string
  validUntil?: string
  paymentMethod?: string
  preparedBy?: string
  placeOfTransaction?: string
  currency?: string
  exchangeRate?: number
  notes?: string
  terms?: string
  footer?: string
  reason?: string
  billingAddress?: BillingAddress
  tags?: string[]
  lines?: LineInput[]
}

export interface DocumentTotals {
  /** Σ quantity × unitPrice. */
  subtotal: number
  /** Σ line discount amount. */
  discountTotal: number
  /** Σ line tax amount. */
  taxTotal: number
  /** subtotal − discountTotal + taxTotal. */
  total: number
}

/** Coerce anything to a finite number (mirrors v-model.number which yields numbers but
 *  can leave 0/NaN for blank fields). */
export function num(v: unknown): number {
  if (typeof v === 'number') return isNaN(v) ? 0 : v
  const n = Number(v)
  return isNaN(n) ? 0 : n
}

/** The `+(x).toFixed(2)` rounding the legacy forms use everywhere. */
export function round2(v: number): number {
  return +num(v).toFixed(2)
}

export interface LineAmounts {
  net: number
  discountAmount: number
  taxable: number
  taxAmount: number
  total: number
}

/**
 * Per-line raw (unrounded) amounts.
 *  - discount-aware (sales invoice, proforma): taxable = net − net·discount%, then tax.
 *  - non-discount (purchase, credit, debit, cash): legacy expressions reproduced exactly
 *    (`qty·price·rate/100` and `qty·price·(1 + rate/100)`).
 */
export function lineAmounts(l: LineInput, hasDiscount: boolean): LineAmounts {
  const net = num(l.quantity) * num(l.unitPrice)
  if (hasDiscount) {
    const discountAmount = net * (num(l.discount) / 100)
    const taxable = net - discountAmount
    const taxAmount = taxable * (num(l.taxRate) / 100)
    return { net, discountAmount, taxable, taxAmount, total: taxable + taxAmount }
  }
  const taxAmount = net * num(l.taxRate) / 100
  return { net, discountAmount: 0, taxable: net, taxAmount, total: net * (1 + num(l.taxRate) / 100) }
}

/** Lines that count toward totals / get persisted: only those linked to a product.
 *  Empty trailing rows (no productId) are placeholders and are dropped. */
export function filledLines(lines: LineInput[] | undefined): LineInput[] {
  return (lines || []).filter((l) => !!l.productId)
}

/** Unrounded aggregate totals (the payload rounds them; the UI formats them). */
export function computeTotals(
  lines: LineInput[] | undefined,
  config: DocumentTypeConfig,
): DocumentTotals {
  const hasDiscount = config.line.hasDiscount
  let subtotal = 0
  let discountTotal = 0
  let taxTotal = 0
  for (const l of filledLines(lines)) {
    const a = lineAmounts(l, hasDiscount)
    subtotal += a.net
    discountTotal += a.discountAmount
    taxTotal += a.taxAmount
  }
  return { subtotal, discountTotal, taxTotal, total: subtotal - discountTotal + taxTotal }
}

/** The persisted line objects (one per filled line), with config-gated keys. */
export function buildPayloadLines(
  lines: LineInput[] | undefined,
  config: DocumentTypeConfig,
): Record<string, any>[] {
  const { hasDiscount, hasAccountId, unitFallback } = config.line
  return filledLines(lines).map((l) => {
    const a = lineAmounts(l, hasDiscount)
    const out: Record<string, any> = {
      productId: l.productId || undefined,
      description: l.description,
      quantity: l.quantity,
      unit: unitFallback ? (l.unit || 'pcs') : l.unit,
      unitPrice: l.unitPrice,
    }
    if (hasDiscount) out.discount = l.discount
    out.taxRate = l.taxRate
    out.taxAmount = round2(a.taxAmount)
    out.lineTotal = round2(a.total)
    if (hasAccountId) out.accountId = l.accountId || undefined
    out.warehouseId = l.warehouseId || undefined
    out.priceExplanation = l.priceExplanation || undefined
    return out
  })
}

/** productUpdates[] for the with-product-update flow: one entry per filled line whose
 *  staged productUpdate has values or whose tiers were touched. Mirrors the inventory
 *  movements form builder (MovementFormView.buildProductUpdates). */
export function buildProductUpdates(lines: LineInput[] | undefined): Record<string, any>[] {
  const updates: Record<string, any>[] = []
  for (const line of filledLines(lines)) {
    const u: Record<string, any> = { productId: line.productId }
    let hasChanges = false
    for (const [k, v] of Object.entries(line.productUpdate || {})) {
      if (v !== undefined && v !== '') { u[k] = v; hasChanges = true }
    }
    // Only attach priceTiers if the user actually touched them (override set or any price > 0).
    if (Array.isArray(line.priceTiers) && line.priceTiers.length > 0) {
      const anyTouched = line.priceTiers.some(t => t.manualOverride || (t.finalPrice || 0) > 0)
      if (anyTouched) {
        u.priceTiers = line.priceTiers.slice(0, 10).map(t => ({
          name: t.name,
          percent: Number(t.percent) || 0,
          finalPrice: Number(t.finalPrice) || 0,
          manualOverride: !!t.manualOverride,
          contactIds: t.contactIds || [],
          tags: t.tags || [],
        }))
        hasChanges = true
      }
    }
    if (hasChanges) updates.push(u)
  }
  return updates
}

/**
 * Build the create/update request body for `config`'s document type.
 *
 * Returns a plain object that may contain `undefined`-valued keys; on the wire those are
 * dropped by JSON serialisation (the omit-when-empty behaviour). Callers must NOT strip
 * undefined themselves — that mirrors how axios sends it.
 */
export function buildPayload(
  state: DocumentFormState,
  config: DocumentTypeConfig,
): Record<string, any> {
  const pc = config.payload
  const totals = computeTotals(state.lines, config)
  const subtotal = round2(totals.subtotal)
  const total = round2(totals.total)
  const exchangeRate = pc.exchangeRateFallback
    ? (num(state.exchangeRate) || 1)
    : state.exchangeRate

  const p: Record<string, any> = {}

  // identity
  p.contactId = pc.contactIdOmitEmpty ? (state.contactId || undefined) : state.contactId
  p.type = config.apiType
  p.direction = config.direction

  // header extras
  if (pc.emitSupplierInvoiceNumber) p.supplierInvoiceNumber = state.supplierInvoiceNumber
  if (pc.emitRelatedInvoiceId) p.relatedInvoiceId = state.relatedInvoiceId

  // dates
  if (pc.emitDateField) p.date = state.issueDate
  if (pc.emitIssueDate) p.issueDate = state.issueDate
  if (pc.emitDueDate) {
    p.dueDate = pc.dueDateFallbackToIssue ? (state.dueDate || state.issueDate) : state.dueDate
  }
  if (pc.emitValidUntil) p.validUntil = state.validUntil

  // payment
  if (pc.emitPaymentMethod) p.paymentMethod = state.paymentMethod

  // signature footer (Съставил / Място на сделката) — emitted when present
  if ((state as any).preparedBy) p.preparedBy = (state as any).preparedBy
  if ((state as any).placeOfTransaction) p.placeOfTransaction = (state as any).placeOfTransaction

  // money
  p.currency = state.currency
  p.exchangeRate = exchangeRate

  // lines + totals
  p.lines = buildPayloadLines(state.lines, config)
  p.subtotal = subtotal
  if (config.totals.emitDiscountTotal) p.discountTotal = round2(totals.discountTotal)
  if (config.totals.emitTaxTotal) p.taxTotal = round2(totals.taxTotal)
  p.total = total
  if (config.totals.emitTotalBase) p.totalBase = round2(total * num(exchangeRate))

  // free-text fields
  for (const f of pc.textFields) {
    const v = (state as any)[f] ?? ''
    p[f] = pc.omitEmptyText ? (v || undefined) : v
  }

  // billing address (sales invoice)
  if (pc.emitBillingAddress) {
    const b = state.billingAddress || {}
    p.billingAddress = {
      street: b.street,
      city: b.city,
      state: b.state || undefined,
      postalCode: b.postalCode,
      country: b.country,
    }
  }

  // tags
  p.tags = state.tags || []

  return p
}
