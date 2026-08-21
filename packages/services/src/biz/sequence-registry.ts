/**
 * THE registry of document sequences — the single source of truth behind
 * `/invoicing/configuration/sequences`.
 *
 * Every counter key, its default display prefix, and which document group/variant it
 * serves is declared here once. Numbering (`invoice-numbering.service.ts`), the
 * configuration controller, and the order/internal-order/reservation allocators all read
 * this table instead of repeating string literals — so what an org configures on the
 * sequences page is what every allocation path actually uses.
 *
 * Resolution order for the prefix rendered on a document number:
 *   org override for the counter key (year=0 sentinel)  →  `defaultDisplay` below.
 * `resolveSequencePrefix()` implements it; nothing should hardcode a prefix literal.
 */
import { getDisplayPrefix } from './sequence.service.js'

export type SequenceGroup =
  | 'invoice'
  | 'proforma'
  | 'credit_note'
  | 'debit_note'
  | 'bill'
  | 'cash_sale'
  | 'order'
  | 'internal_order'
  | 'reservation'
  | 'certificate'
  | 'pp_protocol'

export type SequenceVariant = 'draft' | 'issued'

export interface SequenceKeyDef {
  /** Counter key stored on the Sequence document (also the key an override is written under). */
  prefix: string
  /** Prefix rendered on the number when the org has set no override. */
  defaultDisplay: string
  group: SequenceGroup
  variant: SequenceVariant
  /**
   * Listed on the configuration page for completeness, but no allocation path uses it.
   * Cash sales have no draft state — they go straight to issued.
   */
  unused?: boolean
}

/**
 * External orders keep the historical ORDER/DRAFT_ORD counter keys (numbering continues
 * across the ORD→ORDO rename); only the default display prefix changed.
 *
 * SALES_DOC intentionally appears three times: INV/CRN/DBN share one counter so their
 * numbering interleaves, but each renders its own prefix.
 */
export const INVOICING_SEQUENCE_KEYS: SequenceKeyDef[] = [
  // Drafts (per-type counters)
  { prefix: 'DRAFT_INV',  defaultDisplay: 'DRF-INV',  group: 'invoice',        variant: 'draft' },
  { prefix: 'DRAFT_PRF',  defaultDisplay: 'DRF-PRF',  group: 'proforma',       variant: 'draft' },
  { prefix: 'DRAFT_CN',   defaultDisplay: 'DRF-CN',   group: 'credit_note',    variant: 'draft' },
  { prefix: 'DRAFT_DN',   defaultDisplay: 'DRF-DN',   group: 'debit_note',     variant: 'draft' },
  { prefix: 'DRAFT_BILL', defaultDisplay: 'DRF-BILL', group: 'bill',           variant: 'draft' },
  { prefix: 'DRAFT_CS',   defaultDisplay: 'DRF-CS',   group: 'cash_sale',      variant: 'draft', unused: true },
  { prefix: 'DRAFT_ORD',  defaultDisplay: 'DRF-ORDO', group: 'order',          variant: 'draft' },
  { prefix: 'DRAFT_ORDI', defaultDisplay: 'DRF-ORDI', group: 'internal_order', variant: 'draft' },
  // Issued (SALES_DOC shared by INV+CN+DN, others per-type)
  { prefix: 'SALES_DOC',  defaultDisplay: 'INV',      group: 'invoice',        variant: 'issued' },
  { prefix: 'SALES_DOC',  defaultDisplay: 'CRN',      group: 'credit_note',    variant: 'issued' },
  { prefix: 'SALES_DOC',  defaultDisplay: 'DBN',      group: 'debit_note',     variant: 'issued' },
  { prefix: 'PROFORMA',   defaultDisplay: 'PRF',      group: 'proforma',       variant: 'issued' },
  { prefix: 'BILL',       defaultDisplay: 'BILL',     group: 'bill',           variant: 'issued' },
  { prefix: 'CASH_SALE',  defaultDisplay: 'CS',       group: 'cash_sale',      variant: 'issued' },
  { prefix: 'ORDER',      defaultDisplay: 'ORDO',     group: 'order',          variant: 'issued' },
  { prefix: 'INTERNAL_ORDER', defaultDisplay: 'ORDI', group: 'internal_order', variant: 'issued' },
  { prefix: 'RESERVATION', defaultDisplay: 'RES',     group: 'reservation',    variant: 'issued' },
  // Companion documents printed alongside an outgoing sales document — own running numbers.
  { prefix: 'CERTIFICATE', defaultDisplay: 'CERT',    group: 'certificate',    variant: 'issued' },
  { prefix: 'PP_PROTOCOL', defaultDisplay: 'PPP',     group: 'pp_protocol',    variant: 'issued' },
]

/** Map an invoicing document (type + direction) onto its sequence group. */
export function sequenceGroupFor(type: string, direction?: string): SequenceGroup {
  if (type === 'proforma') return 'proforma'
  if (type === 'cash_sale') return 'cash_sale'
  if (type === 'credit_note') return 'credit_note'
  if (type === 'debit_note') return 'debit_note'
  if (type === 'invoice') return direction === 'incoming' ? 'bill' : 'invoice'
  // Non-invoice groups address the registry by group name directly.
  return (INVOICING_SEQUENCE_KEYS.find(e => e.group === type)?.group as SequenceGroup) || 'invoice'
}

/** The registry row for a group/variant, or null when that combination doesn't allocate. */
export function sequenceDefFor(group: SequenceGroup, variant: SequenceVariant): SequenceKeyDef | null {
  const row = INVOICING_SEQUENCE_KEYS.find(e => e.group === group && e.variant === variant)
  if (!row || row.unused) return null
  return row
}

/**
 * The prefix an org actually renders for a group/variant: its configured override if any,
 * else the registry default. This is the ONLY function that should decide a prefix —
 * callers must never fall back to a literal.
 *
 * Overrides are looked up under the DISPLAY prefix first and then under the counter key —
 * the configuration page writes the counter key, but legacy overrides were written under
 * the display prefix and must keep winning. Order matters for SALES_DOC, where one counter
 * backs three display prefixes (INV/CRN/DBN): a per-prefix override has to beat the shared
 * counter override.
 */
export async function resolveSequencePrefix(
  orgId: string,
  group: SequenceGroup,
  variant: SequenceVariant,
): Promise<string | null> {
  const def = sequenceDefFor(group, variant)
  if (!def) return null
  return resolveDefPrefix(orgId, def)
}

/** Same resolution for an already-known registry row. */
export async function resolveDefPrefix(orgId: string, def: SequenceKeyDef): Promise<string> {
  const byDisplay = await getDisplayPrefix(orgId, def.defaultDisplay)
  if (byDisplay !== def.defaultDisplay) return byDisplay
  const byKey = await getDisplayPrefix(orgId, def.prefix)
  if (byKey !== def.prefix) return byKey
  return def.defaultDisplay
}
