/**
 * Invoice/document numbering — sequence keys, display prefixes and number allocation.
 *
 * Extracted verbatim from `invoicing-api/src/controllers/invoice.controller.ts` so the
 * doc-import engine (which lives in `services/biz/doc-import/`) can allocate numbers
 * without importing from a controller — that would invert the package dependency
 * (config ← db ← services ← *-api). The controller re-exports every symbol here, so
 * existing importers keep working unchanged.
 */
import { Invoice } from 'db/models'
import { getNextNumber, ensureSequenceAtLeast, getDisplayPrefix } from './sequence.service.js'
import {
  INVOICING_SEQUENCE_KEYS,
  sequenceDefFor,
  sequenceGroupFor,
  resolveDefPrefix,
  type SequenceVariant,
} from './sequence-registry.js'

// Prefix rendered on the invoice number, derived from the sequences registry so the
// configuration page (/invoicing/configuration/sequences) stays the single source of truth.
export const TYPE_PREFIX: Record<string, string> = Object.fromEntries(
  (['cash_sale', 'proforma', 'credit_note', 'debit_note'] as const)
    .map(t => [t, sequenceDefFor(sequenceGroupFor(t), 'issued')?.defaultDisplay || 'INV']),
)

// Prefixes that share a single counter under `SALES_DOC`. Numbering must interleave across
// these types so that if INV is at 10 the next CRN is 11, not 3.
export const SALES_DOC_PREFIXES: string[] = INVOICING_SEQUENCE_KEYS
  .filter(e => e.prefix === 'SALES_DOC')
  .map(e => e.defaultDisplay)

/**
 * Issued sequence counter key. INV/CRN/DBN share a single counter (SALES_DOC) so the
 * sequence interleaves across those three types. PRF, CS, BILL get their own counters.
 */
export function sequenceKeyFor(type: string, direction: string): string {
  return sequenceDefFor(sequenceGroupFor(type, direction), 'issued')?.prefix || 'SALES_DOC'
}

/** DEFAULT display prefix for a type. Prefer `resolveDocPrefix()` — it honours org overrides. */
export function prefixFor(type: string, direction: string): string {
  return sequenceDefFor(sequenceGroupFor(type, direction), 'issued')?.defaultDisplay || 'INV'
}

/**
 * Draft sequences are PER-TYPE (not shared) so each draft series has its own clean counter.
 * Cash sales never have a draft state — they go straight to issued, which the registry
 * records by marking DRAFT_CS `unused`.
 */
export function draftSequenceKeyFor(type: string, direction: string): string | null {
  return sequenceDefFor(sequenceGroupFor(type, direction), 'draft')?.prefix || null
}

/** DEFAULT draft display prefix. Prefer `resolveDocPrefix()` — it honours org overrides. */
export function draftPrefixFor(type: string, direction: string): string | null {
  return sequenceDefFor(sequenceGroupFor(type, direction), 'draft')?.defaultDisplay || null
}

/**
 * The prefix this org actually renders for a document — its configured override if any,
 * else the registry default. Every path that needs to BUILD or RECOGNISE a document number
 * must go through this instead of assuming "INV"/"BILL"/"DRF-INV".
 */
export async function resolveDocPrefix(
  orgId: string,
  type: string,
  direction: string,
  variant: SequenceVariant = 'issued',
): Promise<string | null> {
  const def = sequenceDefFor(sequenceGroupFor(type, direction), variant)
  if (!def) return null
  return resolveDefPrefix(orgId, def)
}

/** Escape a display prefix for embedding in a RegExp (prefixes allow `-` and `_`). */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Scan existing invoices that share the given sequence key and return the highest trailing
 * numeric suffix already in use for `year`. Used to bootstrap `lastNumber` when legacy rows
 * (seeds, pre-refactor per-prefix counters) have numbers above the current sequence value.
 */
export async function currentMaxSuffix(orgId: string, key: string, year: number): Promise<number> {
  // Every display prefix this counter renders — registry defaults PLUS whatever the org
  // configured on the sequences page, so renaming a prefix doesn't hide existing numbers.
  const defs = INVOICING_SEQUENCE_KEYS.filter(e => e.prefix === key && e.variant === 'issued')
  if (!defs.length) return 0
  const prefixes = [...new Set(
    (await Promise.all(defs.map(async d => [d.defaultDisplay, await resolveDefPrefix(orgId, d)]))).flat(),
  )]

  const re = new RegExp(`^(?:${prefixes.map(escapeRe).join('|')})-${year}-(\\d+)$`)
  const docs = await Invoice
    .find({ orgId, invoiceNumber: { $regex: re } } as any, { invoiceNumber: 1 })
    .lean()
    .exec()
  let max = 0
  for (const d of docs) {
    const m = (d as any).invoiceNumber?.match(re)
    if (m) {
      const n = Number(m[1])
      if (n > max) max = n
    }
  }
  return max
}

/**
 * Display-prefix override resolution. The configuration UI stores overrides under the
 * COUNTER key ("CASH_SALE", "SALES_DOC", "DRAFT_INV", …) while allocation historically
 * looked them up under the type prefix ("CS", "INV", "DRF-INV") — check both, type
 * prefix winning, so overrides work regardless of which key carries them.
 */
export async function resolveDisplayPrefix(orgId: string, typePrefix: string, counterKey: string | null): Promise<string> {
  const byType = await getDisplayPrefix(orgId, typePrefix)
  if (byType !== typePrefix) return byType
  if (counterKey) {
    const byKey = await getDisplayPrefix(orgId, counterKey)
    if (byKey !== counterKey) return byKey
  }
  return typePrefix
}

export async function getNextInvoiceNumber(orgId: string, direction: string, type?: string): Promise<string> {
  const t = type || 'invoice'
  const key = sequenceKeyFor(t, direction)
  const year = new Date().getFullYear()

  // Reconcile: ensure the shared counter has caught up with any pre-existing numbers in the
  // same prefix group (fixes legacy data where the per-prefix counter pre-dated SALES_DOC,
  // or where seeds inserted invoiceNumbers directly without bumping a counter).
  const minValue = await currentMaxSuffix(orgId, key, year)
  if (minValue > 0) await ensureSequenceAtLeast(orgId, key, year, minValue)

  // Atomic $inc. Shared key → shared counter. The counter value is formatted with the
  // org's configured prefix (SALES_DOC=11 → "INV-2026-00011" or "CRN-2026-00011" etc.).
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = (await resolveDocPrefix(orgId, t, direction, 'issued')) || prefixFor(t, direction)
  return `${display}-${year}-${seqPart}`
}

/**
 * Allocate the next draft number for documents in draft state. Per-type counters
 * (no SALES_DOC sharing on the draft side). Cash sales never use this — they're
 * issued immediately, which the registry records by marking DRAFT_CS `unused`.
 */
export async function getNextDraftInvoiceNumber(orgId: string, direction: string, type?: string): Promise<string | null> {
  const t = type || 'invoice'
  const draftKey = draftSequenceKeyFor(t, direction)
  if (!draftKey) return null
  const display = await resolveDocPrefix(orgId, t, direction, 'draft')
  if (!display) return null
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, draftKey, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  return `${display}-${year}-${seqPart}`
}
