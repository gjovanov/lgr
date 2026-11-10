import { getNextNumber } from './sequence.service.js'
import { sequenceDefFor, resolveSequencePrefix } from './sequence-registry.js'

/**
 * Supplier orders get their own counters: issued ORDO-YYYY-NNNNN (key ORDER), drafts DRF-ORDO-YYYY-NNNNN (key
 * DRAFT_ORD). Customer orders: issued ORDI-YYYY-NNNNN (key INTERNAL_ORDER), drafts DRF-ORDI-YYYY-NNNNN (key
 * DRAFT_ORDI). The counter keys predate the ORD→ORDO rename — numbering continues across it; only the display
 * prefix changed. Display prefixes are the org's (`resolveSequencePrefix`), never hardcoded.
 *
 * Moved here from the two order controllers so the order made from the Products list (FR-28.17, .18) allocates
 * numbers exactly as they do; the controllers re-export them under their old names.
 */
async function nextOrderDocumentNumber(orgId: string, kind: 'order' | 'internal_order', draft: boolean): Promise<string> {
  const variant = draft ? 'draft' : 'issued'
  const key = sequenceDefFor(kind, variant)!.prefix
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveSequencePrefix(orgId, kind, variant)
  return `${display}-${year}-${seqPart}`
}

export const getNextOrderNumber = (orgId: string, draft: boolean): Promise<string> => nextOrderDocumentNumber(orgId, 'order', draft)

export const getNextInternalOrderNumber = (orgId: string, draft: boolean): Promise<string> => nextOrderDocumentNumber(orgId, 'internal_order', draft)
