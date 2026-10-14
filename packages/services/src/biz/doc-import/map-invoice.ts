/**
 * Extraction → a form-shaped invoice mapping. **Nothing is persisted here.**
 *
 * The batch path hands the result to `persistInvoiceDraft`; the single-document path
 * returns it to the browser, where the user diffs it against the open form. Splitting
 * mapping from persistence is what lets one engine serve both.
 *
 * The one deliberate side effect is contact creation, and only when the caller asks for it
 * (`createMissingContact`) — the migration importer has always created counterparties it
 * had never seen, while the single-document path offers the user a choice instead.
 */
import { Order, Org } from 'db/models'
import { amountInWordsLocale, upsertAmountInWords } from 'config/amount-in-words'
import { normalizeUomBg } from '../uom.utils.js'
import { clean, detectDirection, num } from './detect.js'
import { matchContact, matchLines, type ContactMatch, type ProductMatch } from './matching.js'
import { parseNoteReference } from './detect.js'
import {
  parsePartyAddresses,
  parsePaymentMethod,
  parsePlaceOfTransaction,
  parsePreparedBy,
  parseSlovom,
  parseTerms,
} from './parse-text.js'
import type {
  ContactSuggestion,
  DocumentExtraction,
  DraftResult,
  LineDiagnostic,
  MappedInvoice,
  MappedInvoiceLine,
} from './types.js'

export interface MapInvoiceOptions {
  /** Fallback warehouse for matched lines (and for allocation overflow). */
  warehouseId?: string
  /** ORDO context: match lines against this order's supplier group and split per allocation. */
  orderId?: string
  /** Create the counterparty when no contact matches. Batch: true. Single-document: false. */
  createMissingContact?: boolean
  /** Correlation tag written onto the draft (`ocr:<batchId>`). */
  batchId?: string
  /** Force the document type. Defaults to 'invoice'; cash-sale imports pass 'cash_sale'. */
  type?: string
  /** Force the direction instead of deriving it from the org's ЕИК. */
  direction?: 'outgoing' | 'incoming'
}

export interface MapInvoiceResult {
  mapped: MappedInvoice
  perLine: LineDiagnostic[]
  /** The resolved counterparty, when one matched (or was created). */
  contact: ContactMatch | null
  /** Set instead of `contact` when nothing matched and creation was not requested. */
  contactSuggestion?: ContactSuggestion
  uncertain: boolean
  orderGroupMatched: boolean
  warnings: string[]
}

function toAddress(a: any) {
  return {
    street: clean(a?.street) || '-', city: clean(a?.city) || '-',
    postalCode: clean(a?.postalCode) || '-', country: clean(a?.country) || 'BG',
  }
}

/**
 * Split a received quantity across an order line's warehouse allocations,
 * filling remaining capacity (quantity − receivedQuantity) in listed order.
 * Overflow (more received than allocated) lands in the fallback warehouse.
 */
export function splitAcrossAllocations(
  orderLine: any,
  qty: number,
  fallbackWarehouseId?: string,
): Array<{ warehouseId?: string; allocationId?: string; quantity: number }> {
  const parts: Array<{ warehouseId?: string; allocationId?: string; quantity: number }> = []
  let remaining = qty
  for (const alloc of orderLine?.allocations || []) {
    if (remaining <= 0) break
    const capacity = Math.max(0, (Number(alloc.quantity) || 0) - (Number(alloc.receivedQuantity) || 0))
    if (capacity <= 0) continue
    const take = Math.min(capacity, remaining)
    parts.push({ warehouseId: String(alloc.warehouseId), allocationId: String(alloc._id), quantity: take })
    remaining -= take
  }
  if (remaining > 0) parts.push({ warehouseId: fallbackWarehouseId || undefined, quantity: remaining })
  return parts
}

/** ISO date string (YYYY-MM-DD) for the form, from whatever the extraction produced. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export async function mapInvoiceExtraction(
  orgId: string,
  draft: DraftResult,
  rawText = '',
  opts: MapInvoiceOptions = {},
): Promise<MapInvoiceResult> {
  const ext: DocumentExtraction = draft.extraction
  const org: any = await Org.findById(orgId).lean()
  const type = opts.type || 'invoice'
  const detected = detectDirection(org, ext)
  const direction = opts.direction || detected.direction
  const contactType: 'customer' | 'supplier' = direction === 'incoming' ? 'supplier' : 'customer'
  const counterparty = opts.direction && opts.direction !== detected.direction
    ? (direction === 'incoming' ? ext.supplier : ext.customer) || {}
    : detected.counterparty
  const warnings: string[] = []

  // The AI sometimes drops the party Град/Адрес (two-column layout) — backfill the
  // counterparty from the deterministic raw-text party block before matching.
  const parsed = parsePartyAddresses(rawText)
  const cpParsed = direction === 'outgoing' ? parsed.receiver : parsed.supplier
  if (!clean(counterparty?.address) && cpParsed.street) counterparty.address = cpParsed.street
  if (!clean(counterparty?.city) && cpParsed.city) counterparty.city = cpParsed.city

  const contact = await matchContact(orgId, counterparty, contactType, { create: opts.createMissingContact !== false })
  // Billing address = the counterparty's (the invoice recipient), not the warehouse's.
  const billingAddress = toAddress(contact?.address)

  let contactSuggestion: ContactSuggestion | undefined
  if (!contact && clean(counterparty?.name)) {
    contactSuggestion = {
      name: clean(counterparty.name),
      eik: clean(counterparty.company_id) || undefined,
      vat: clean(counterparty.vat_id) || undefined,
      address: clean(counterparty.address) || undefined,
      city: clean(counterparty.city) || undefined,
    }
  }

  // ── ORDO context: the order + this supplier's group (matched by counterparty) ──
  let order: any = null
  let orderGroup: any = null
  if (opts.orderId && direction === 'incoming' && contact) {
    order = await Order.findOne({ _id: opts.orderId, orgId } as any).lean()
    orderGroup = (order?.supplierGroups || []).find((g: any) => String(g.supplierId) === contact.contactId) || null
    if (!orderGroup) warnings.push('supplier is not a group on this order')
  }
  // Working copy of the group lines so allocation capacity consumed by earlier lines
  // of THIS document isn't offered again to later ones.
  const workingByProduct = new Map<string, any>()
  if (orderGroup) {
    for (const ol of JSON.parse(JSON.stringify(orderGroup.lines || []))) {
      if (ol.productId) workingByProduct.set(String(ol.productId), ol)
    }
  }

  const items = (ext.line_items || [])
    .map(li => ({ li, desc: clean(li.description) }))
    .filter(e => !!e.desc)

  const aiCandidates = orderGroup
    ? (orderGroup.lines || [])
        .filter((l: any) => l.productId)
        .map((l: any) => ({ id: String(l.productId), name: String(l.description || ''), sku: l.sku || undefined }))
    : undefined

  const matches = await matchLines(orgId, items.map(e => e.desc), {
    supplierId: contact && direction === 'incoming' ? contact.contactId : undefined,
    aiCandidates,
  })

  const lines: MappedInvoiceLine[] = []
  const perLine: LineDiagnostic[] = []

  items.forEach(({ li, desc }, i) => {
    const match: ProductMatch | null = matches[i]
    const matchedBy = match?.matchedBy ?? null
    const qty = num(li.quantity)
    let price = num(li.unit_price)
    const taxRate = li.vat_rate != null ? num(li.vat_rate) : 20
    const lineTotal = li.total != null ? num(li.total) : +(qty * price).toFixed(2)
    // Legacy PDFs display the unit price rounded to 4 decimals but the line total is
    // exact (3000 × 0.0213 ≠ 64.00). Derive a price that reproduces the total so
    // qty × unitPrice recomputations (form totals, payload) agree with the document.
    if (li.total != null && qty > 0 && Math.abs(qty * price - lineTotal) > 0.001) {
      price = +(lineTotal / qty).toFixed(6)
    }
    const taxAmount = +((lineTotal * taxRate) / 100).toFixed(2)
    const unit = normalizeUomBg(match?.unit || li.unit)
    // Alias/AI matches carry the supplier's wording — show OUR catalog name and keep
    // the original in sourceText (exact matches keep the extracted text verbatim).
    const displayDesc = (matchedBy === 'alias' || matchedBy === 'ai') && match?.name ? match.name : desc

    const orderLine = match && orderGroup ? workingByProduct.get(match.productId) : null
    if (orderLine) {
      // One invoice line per warehouse allocation part; the last part absorbs the
      // rounding residue so the parts still sum to the document's line total.
      const parts = splitAcrossAllocations(orderLine, qty, opts.warehouseId)
      let remainingTotal = lineTotal
      parts.forEach((part, idx) => {
        const isLast = idx === parts.length - 1
        const partTotal = isLast ? +remainingTotal.toFixed(2) : +(part.quantity * price).toFixed(2)
        remainingTotal -= partTotal
        lines.push({
          productId: match!.productId, description: displayDesc, quantity: part.quantity,
          unit, unitPrice: price, discount: 0, taxRate,
          taxAmount: +((partTotal * taxRate) / 100).toFixed(2),
          lineTotal: partTotal,
          warehouseId: part.warehouseId,
          sourceText: desc,
          orderRef: {
            groupId: String(orderGroup._id),
            lineId: String(orderLine._id),
            ...(part.allocationId ? { allocationId: part.allocationId } : {}),
          },
        })
        if (part.allocationId) {
          const wa = (orderLine.allocations || []).find((a: any) => String(a._id) === part.allocationId)
          if (wa) wa.receivedQuantity = (Number(wa.receivedQuantity) || 0) + part.quantity
        }
      })
      perLine.push({ sourceText: desc, matched: true, productId: match!.productId, matchedBy })
    } else {
      lines.push({
        productId: match?.productId, description: displayDesc, quantity: qty,
        unit, unitPrice: price, discount: 0,
        taxRate, taxAmount, lineTotal, warehouseId: match ? opts.warehouseId : undefined,
        sourceText: desc,
      })
      perLine.push({ sourceText: desc, matched: !!match, productId: match?.productId, matchedBy })
    }
  })

  const subtotal = ext.net_total != null ? num(ext.net_total) : +lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2)
  const taxTotal = ext.vat_total != null ? num(ext.vat_total) : +lines.reduce((s, l) => s + l.taxAmount, 0).toFixed(2)
  const total = ext.gross_total != null ? num(ext.gross_total) : +(subtotal + taxTotal).toFixed(2)
  const currency = clean(ext.currency) || 'BGN'
  const exchangeRate = ext.exchange_rate != null ? num(ext.exchange_rate, 1) : 1
  const issueDate = ext.issue_date ? new Date(ext.issue_date) : new Date()
  const dueDate = ext.due_date ? new Date(ext.due_date) : new Date(issueDate.getTime() + 30 * 86_400_000)

  const uncertain = opts.direction ? false : detected.uncertain
  const tags = ['ocr-import', ...(opts.batchId ? [`ocr:${opts.batchId}`] : []), `dir:${direction}`]
  if (uncertain || draft.validation?.status === 'needs_review') tags.push('needs-review')
  if (order && orderGroup) tags.push(`ord:${order.orderNumber}`)
  else if (opts.orderId && direction === 'incoming') tags.push('ord-unmatched')

  const mapped: MappedInvoice = {
    type,
    direction,
    contactId: contact?.contactId,
    contactName: contact?.name || clean(counterparty?.name) || undefined,
    // Original PlusMinus document number — preserved as the issued number on convert.
    reference: clean(ext.document_number) || undefined,
    issueDate: isoDay(issueDate),
    dueDate: isoDay(dueDate),
    currency,
    exchangeRate,
    paymentMethod: parsePaymentMethod(rawText, ext.payment_terms),
    terms: parseTerms(rawText),
    // Notes carry the amount-in-words line ("Словом : ...") — AI's version, else raw-text parse.
    notes: clean(ext.notes) || parseSlovom(rawText),
    preparedBy: parsePreparedBy(rawText),
    placeOfTransaction: parsePlaceOfTransaction(rawText),
    billingAddress,
    lines,
    subtotal,
    taxTotal,
    total,
    orderId: order && orderGroup ? String(order._id) : undefined,
    orderGroupId: orderGroup ? String(orderGroup._id) : undefined,
    tags,
  }

  // A кредитно/дебитно известие prints every amount NEGATIVE — quantity, line value and the
  // document total alike. LGR carries that sign on the TYPE instead: auto-journal applies
  // sign = -1 for a credit note, and createInvoiceStockMovement books it as a 'return' INTO the
  // warehouse. Storing the printed negatives as well would double-negate both, so the note is
  // normalised to positive magnitudes here, once, where the type is known.
  if (type === 'credit_note' || type === 'debit_note') {
    for (const l of mapped.lines) {
      l.quantity = Math.abs(l.quantity)
      l.unitPrice = Math.abs(l.unitPrice)
      l.taxAmount = Math.abs(l.taxAmount)
      l.lineTotal = Math.abs(l.lineTotal)
    }
    mapped.subtotal = Math.abs(mapped.subtotal)
    mapped.taxTotal = Math.abs(mapped.taxTotal)
    mapped.total = Math.abs(mapped.total)
    mapped.relatedReference = parseNoteReference(rawText)
    if (!mapped.relatedReference) warnings.push('the note does not name the document it corrects')
  }

  // ⚠ An OUTGOING document is ours, so its amount-in-words line is too: written the way the
  // invoicing form writes it on save (cents spelled, ", Данъчна основа X.XX €" tail), from the
  // totals above. The source line is PlusMinus's ("… и 76 цента Данъчна основа 16.47 €": digit
  // cents, no comma), and stored verbatim it printed that on every imported sales invoice until
  // someone re-saved it. Any other note text is kept. A BILL keeps the supplier's line as
  // extracted — it quotes their document, and nothing of ours should rewrite it.
  if (direction === 'outgoing') {
    const locale = amountInWordsLocale(mapped.notes) || org?.settings?.locale || 'bg'
    mapped.notes = upsertAmountInWords(mapped.notes || '', mapped.total, mapped.subtotal, currency, locale)
  }

  if (!clean(ext.document_number)) warnings.push('no document number found')
  if (!lines.length) warnings.push('no line items extracted')

  return {
    mapped,
    perLine,
    contact,
    contactSuggestion,
    uncertain,
    orderGroupMatched: !!orderGroup,
    warnings,
  }
}
