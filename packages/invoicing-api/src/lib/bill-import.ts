/**
 * Back-compat shim.
 *
 * The import engine now lives in `services/biz/doc-import/` so the movements and cash-sale
 * targets can share it and so mapping can run without persisting (the single-document
 * flow). This module keeps the original surface: the `/bills/import/*` controller, the
 * five CLI skills that drive the deployed endpoints, and the existing integration tests
 * all continue to import from here.
 *
 * New code should import from `services/biz/doc-import/*` directly.
 */
export {
  parsePartyAddresses,
  parsePaymentMethod,
  parseSlovom,
  parsePreparedBy,
  parsePlaceOfTransaction,
  parseTerms,
} from 'services/biz/doc-import/parse-text'
export { matchContact, matchProduct, matchProductViaAlias } from 'services/biz/doc-import/matching'
export { splitAcrossAllocations } from 'services/biz/doc-import/map-invoice'
export { convertDraftInvoice, learnSupplierAliases } from 'services/biz/doc-import/persist'
export type { DocumentExtraction as InvoiceExtraction, DraftResult } from 'services/biz/doc-import/types'

import { mapInvoiceExtraction } from 'services/biz/doc-import/map-invoice'
import { persistInvoiceDraft } from 'services/biz/doc-import/persist'
import type { DraftResult } from 'services/biz/doc-import/types'

/**
 * Create a DRAFT invoice (sales or bill, auto-detected) from an extraction — the original
 * one-shot map+persist entry point.
 *
 * `perLine` keeps its historical `{ description, matched, productId, matchedBy }` shape;
 * the engine's own diagnostics call that field `sourceText`.
 */
export async function createDraftInvoice(
  orgId: string,
  userId: string,
  draft: DraftResult,
  warehouseId: string,
  batchId: string,
  rawText = '',
  opts: { orderId?: string } = {},
) {
  const { mapped, perLine, contact, uncertain, orderGroupMatched } = await mapInvoiceExtraction(orgId, draft, rawText, {
    warehouseId,
    orderId: opts.orderId,
    batchId,
    createMissingContact: true,
  })
  const invoice = await persistInvoiceDraft(orgId, userId, mapped)
  return {
    invoice,
    contact,
    perLine: perLine.map(p => ({
      description: p.sourceText,
      matched: p.matched,
      productId: p.productId ?? null,
      matchedBy: p.matchedBy,
    })),
    direction: mapped.direction,
    uncertain,
    orderGroupMatched,
  }
}
