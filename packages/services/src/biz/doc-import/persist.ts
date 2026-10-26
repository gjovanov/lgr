/**
 * Turning a mapping into stored documents.
 *
 * Everything that writes lives here, so `map-*.ts` stays a pure(ish) transform that the
 * single-document path can run without touching the database.
 */
import { getRepos } from '../../context.js'
import { Product, SupplierProductAlias, normalizeAlias, Warehouse } from 'db/models'
import { matchProductsExact } from './matching.js'
import { logger } from '../../logger/logger.js'
import { createInvoiceStockMovement, unbookableStockLines, unbookableStockMessage } from '../invoicing.service.js'
import { createAuditEntry } from '../audit-log.service.js'
import { ensureSequenceAtLeast } from '../sequence.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { syncCashSettlement } from '../cash-settlement.service.js'
import {
  getNextDraftInvoiceNumber,
  getNextInvoiceNumber,
  resolveDocPrefix,
  sequenceKeyFor,
} from '../invoice-numbering.service.js'
import { clean } from './detect.js'
import { findDuplicateInvoice } from './dedupe.js'
import type { MappedInvoice } from './types.js'

/**
 * Create the DRAFT document for a mapping.
 *
 * Cash sales have no draft state, so `getNextDraftInvoiceNumber` returns null for them and
 * the caller is expected to issue directly instead (see `persistCashSale`).
 */
/**
 * Match the lines the ANALYSIS could not, just before the document is written.
 *
 * A day is imported in one pass: the стокова разписка that CREATES a product commits before the
 * invoice that sells it (that is what `inProcessingOrder` is for) — but both were ANALYSED earlier,
 * when the product did not exist yet. The invoice therefore kept `productId: null`, and because
 * `createInvoiceStockMovement` only books lines that carry a product and a warehouse, it sold 40 of
 * something and moved no stock at all (INV-3000100879 on 2026-08-31: four ШПИЛКА lines, 160 units
 * that stayed on the shelf in LGR). Re-matching here closes the window between analysis and commit.
 *
 * Exact-name matching only — the same rung the analysis used — so this resolves what has appeared
 * since, and never guesses.
 */
async function matchLinesCreatedSinceAnalysis(orgId: string, mapped: MappedInvoice): Promise<number> {
  const pending = mapped.lines.filter(l => !l.productId && String(l.description || '').trim())
  if (!pending.length) return 0

  const hits = await matchProductsExact(orgId, pending.map(l => String(l.description)))
  let resolved = 0
  let fallbackWh: string | undefined
  for (const [i, line] of pending.entries()) {
    const hit = hits[i]
    if (!hit) continue
    line.productId = hit.productId
    if (!line.warehouseId) {
      // A product line with no warehouse is refused outright by the stock booking, so give it the
      // one its siblings use, or the org's default.
      if (fallbackWh === undefined) {
        const whs = await Warehouse.find({ orgId, isActive: { $ne: false } } as any).select('_id isDefault').lean() as any[]
        fallbackWh = mapped.lines.find(l => l.warehouseId)?.warehouseId
          ?? String((whs.find(w => w.isDefault) ?? whs[0])?._id ?? '')
      }
      if (fallbackWh) line.warehouseId = fallbackWh
    }
    resolved++
  }
  if (resolved) logger.info({ orgId, reference: mapped.reference, resolved }, 'doc-import: matched line(s) against products created since the analysis')
  return resolved
}

/**
 * The document a кредитно/дебитно известие corrects, resolved from its „Известие към:" number.
 *
 * PlusMinus numbers notes in the SAME series as the invoices, so the credited document is found
 * the same way `findDuplicateInvoice` finds any legacy number: by `reference` while it is still a
 * draft, or by the org’s configured issued prefix once it has one. A note whose target has not
 * been imported yet simply carries no link — that is not a reason to refuse the note.
 */
async function resolveRelatedInvoice(orgId: string, mapped: MappedInvoice): Promise<string | undefined> {
  if (mapped.type !== 'credit_note' && mapped.type !== 'debit_note') return undefined
  const ref = clean(mapped.relatedReference)
  if (!ref) return undefined
  const hit = await findDuplicateInvoice(orgId, ref, 'invoice', mapped.direction)
  if (!hit) {
    logger.warn({ orgId, note: mapped.reference, corrects: ref }, 'doc-import: the note names a document that is not in the system')
    return undefined
  }
  return hit.id
}

export async function persistInvoiceDraft(
  orgId: string,
  userId: string,
  mapped: MappedInvoice,
): Promise<any> {
  const r = getRepos()
  await matchLinesCreatedSinceAnalysis(orgId, mapped)
  const relatedInvoiceId = await resolveRelatedInvoice(orgId, mapped)
  const draftNumber = await getNextDraftInvoiceNumber(orgId, mapped.direction, mapped.type)
  const issueDate = mapped.issueDate ? new Date(mapped.issueDate) : new Date()
  const dueDate = mapped.dueDate ? new Date(mapped.dueDate) : new Date(issueDate.getTime() + 30 * 86_400_000)

  return r.invoices.create({
    orgId,
    type: mapped.type,
    direction: mapped.direction,
    orderId: mapped.orderId,
    orderGroupId: mapped.orderGroupId,
    contactId: mapped.contactId,
    invoiceNumber: draftNumber, draftNumber,
    reference: mapped.reference,
    ...(relatedInvoiceId ? { relatedInvoiceId } : {}),
    issueDate, dueDate,
    currency: mapped.currency,
    exchangeRate: mapped.exchangeRate,
    lines: mapped.lines,
    subtotal: mapped.subtotal,
    discountTotal: 0,
    taxTotal: mapped.taxTotal,
    total: mapped.total,
    totalBase: +(mapped.total * mapped.exchangeRate).toFixed(2),
    amountDue: mapped.total,
    amountPaid: 0,
    paymentMethod: mapped.paymentMethod,
    terms: mapped.terms,
    notes: mapped.notes,
    preparedBy: mapped.preparedBy,
    placeOfTransaction: mapped.placeOfTransaction,
    billingAddress: mapped.billingAddress,
    status: 'draft',
    statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: 'ocr_import' }],
    numberHistory: draftNumber ? [{ number: draftNumber, allocatedAt: new Date(), status: 'draft' }] : [],
    createdBy: userId,
    tags: mapped.tags,
  } as any)
}

/**
 * Create an ISSUED cash sale.
 *
 * Cash sales have no draft state — the registry marks their draft counter `unused` — so
 * this allocates an issued number straight away and books the document as paid, mirroring
 * what `POST /invoices` does for `type: 'cash_sale'`.
 *
 * The number's prefix comes from the org's sequences configuration; an import never forces
 * one. (The CLI script pins `CSR` for regal-pz — that belongs on the configuration page,
 * not in an importer.)
 *
 * Stock is dispatched unless `adjustStock === false`, and a stock failure rolls the whole
 * document back: a cash sale that exists without its dispatch is worse than none at all.
 */
export async function persistCashSale(
  orgId: string,
  userId: string,
  mapped: MappedInvoice,
  opts: { adjustStock?: boolean } = {},
): Promise<any> {
  const r = getRepos()
  // A cash sale has no draft step, so it needs the same late match the draft path gets.
  await matchLinesCreatedSinceAnalysis(orgId, mapped)
  const invoiceNumber = await getNextInvoiceNumber(orgId, 'outgoing', 'cash_sale')
  const issueDate = mapped.issueDate ? new Date(mapped.issueDate) : new Date()

  const invoice: any = await r.invoices.create({
    orgId,
    type: 'cash_sale',
    direction: 'outgoing',
    contactId: mapped.contactId,
    invoiceNumber,
    reference: mapped.reference,
    issueDate,
    dueDate: issueDate,
    currency: mapped.currency,
    exchangeRate: mapped.exchangeRate,
    lines: mapped.lines,
    subtotal: mapped.subtotal,
    discountTotal: 0,
    taxTotal: mapped.taxTotal,
    total: mapped.total,
    totalBase: +(mapped.total * mapped.exchangeRate).toFixed(2),
    amountPaid: mapped.total,
    amountDue: 0,
    paidAt: new Date(),
    paymentMethod: mapped.paymentMethod || 'cash',
    notes: mapped.notes,
    preparedBy: mapped.preparedBy,
    placeOfTransaction: mapped.placeOfTransaction,
    billingAddress: mapped.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
    status: 'paid',
    statusHistory: [{ status: 'paid', changedAt: new Date(), changedBy: userId, reason: 'cash_register_import' }],
    numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: 'paid' }],
    createdBy: userId,
    tags: mapped.tags,
  } as any)

  if (opts.adjustStock !== false) {
    try {
      // allowNegative — migration dispatches items the warehouse may not hold yet.
      await createInvoiceStockMovement(invoice, userId, undefined, { allowNegative: true })
    } catch (e) {
      await r.invoices.delete(String(invoice.id || invoice._id))
      throw e
    }
  }
  return invoice
}

/**
 * Persist learned supplier wording → product mappings from a confirmed (received)
 * bill. Identity aliases (wording == catalog name modulo whitespace) are skipped.
 * Runs at convert time so review-step corrections are what gets learned.
 */
export async function learnSupplierAliases(orgId: string, invoice: any): Promise<number> {
  const supplierId = invoice?.contactId ? String((invoice.contactId as any)?._id || invoice.contactId) : ''
  if (!supplierId || invoice?.direction !== 'incoming') return 0
  let learned = 0
  const seen = new Set<string>()
  for (const line of invoice?.lines || []) {
    if (!line.productId || !line.sourceText) continue
    const norm = normalizeAlias(line.sourceText)
    if (!norm || seen.has(norm)) continue
    seen.add(norm)
    const prod: any = await Product.findById(line.productId).lean()
    if (!prod) continue
    if (normalizeAlias(prod.name || '') === norm) continue
    await SupplierProductAlias.updateOne(
      { orgId, supplierId, aliasNormalized: norm } as any,
      {
        $set: { aliasText: String(line.sourceText), productId: line.productId, source: 'import', lastUsedAt: new Date() },
        $inc: { hits: 1 },
      },
      { upsert: true },
    )
    learned++
  }
  return learned
}

/**
 * Convert a draft (sales → sent / bill → received): preserve the original number, move stock.
 *
 * The issued number reuses the legacy document number when `reference` is all digits, and
 * bumps the counter past it so future LGR numbers continue beyond the migrated set. The
 * prefix comes from the org's sequences configuration — never a literal.
 */
export async function convertDraftInvoice(
  orgId: string,
  invoiceId: string,
  userId: string,
  opts?: { adjustStock?: boolean },
): Promise<{ ok: boolean; invoiceNumber?: string; direction?: string; error?: string }> {
  const r = getRepos()
  const invoice: any = await r.invoices.findOne({ id: invoiceId, orgId } as any)
  if (!invoice) return { ok: false, error: 'not found' }
  if (invoice.status !== 'draft') return { ok: false, error: 'not in draft status' }

  /**
   * ⚠ Refuse BEFORE anything is mutated.
   *
   * The booking guard inside `createInvoiceStockMovement` used to be the only check, and it runs
   * AFTER this function has allocated the issued number and flipped the invoice to sent/received.
   * A document with an unmatchable line therefore ended up persisted as `sent`, carrying its
   * issued number and NO stock movement, while its DocFile still read `analyzed` — and a
   * re-commit could not fix it, because `persist` creates invoices and never upserts by number,
   * so the retry produced a second row of the same number.
   *
   * It happened three times on regal-sf in two days (INV-2000129121, -151, -165), each needing a
   * manual delete before the document could be booked. Same predicate as the booking guard, so
   * the two cannot disagree about what is bookable.
   */
  if (opts?.adjustStock !== false) {
    const unresolved = unbookableStockLines(invoice)
    if (unresolved.length) return { ok: false, error: unbookableStockMessage(invoice, unresolved) }
  }

  const direction = invoice.direction as string
  const type = invoice.type as string
  const draftNumber = invoice.invoiceNumber
  const year = new Date().getFullYear()

  const orig = clean(invoice.reference)
  let issuedNumber: string
  if (/^\d+$/.test(orig)) {
    const display = await resolveDocPrefix(orgId, type, direction, 'issued')
    issuedNumber = `${display}-${orig}`
    await ensureSequenceAtLeast(orgId, sequenceKeyFor(type, direction), year, Number(orig))
  } else {
    issuedNumber = await getNextInvoiceNumber(orgId, direction, type)
  }

  const newStatus = direction === 'outgoing' ? 'sent' : 'received'
  const statusHistory = [...(invoice.statusHistory || []), { status: newStatus, fromStatus: invoice.status, changedAt: new Date(), changedBy: userId }]
  const numberHistory = [...(invoice.numberHistory || []), { number: issuedNumber, allocatedAt: new Date(), status: newStatus }]
  const updated = await r.invoices.update(invoiceId, {
    status: newStatus, sentAt: new Date(), statusHistory, invoiceNumber: issuedNumber, draftNumber, numberHistory,
  } as any)

  // Stock is skippable: when the inventory baseline (opening-stock / availability
  // snapshot) already reflects these sales, converting must not dispatch again.
  // allowNegative — migration dispatches items that may not be in the warehouse yet.
  if (opts?.adjustStock !== false) {
    await createInvoiceStockMovement(updated || invoice, userId, undefined, { allowNegative: true })
  }
  // Confirmed bills teach the per-supplier alias dictionary; ORDO-linked documents
  // additionally book their receipt onto the order (receivedQuantity, status, holds).
  if (direction === 'incoming') {
    await learnSupplierAliases(orgId, updated || invoice)
  }
  await syncOrderForInvoice(orgId, updated || invoice, userId)
  // A sales invoice paid in cash („Плащане: В брой") is paid as it is issued, like one from /send.
  await syncCashSettlement(orgId, invoiceId, userId)
  createAuditEntry({
    orgId, userId, action: newStatus, module: 'invoicing', entityType: 'invoice',
    entityId: invoiceId, entityName: issuedNumber, changes: { invoiceNumber: { from: draftNumber, to: issuedNumber } },
  })
  return { ok: true, invoiceNumber: issuedNumber, direction }
}
