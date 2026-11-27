/**
 * Invoice/document numbering — sequence keys, display prefixes and number allocation.
 *
 * Extracted verbatim from `api/src/invoicing/controllers/invoice.controller.ts` so the
 * doc-import engine (which lives in `services/biz/doc-import/`) can allocate numbers
 * without importing from a controller — that would invert the package dependency
 * (config ← db ← services ← api). The controller re-exports every symbol here, so
 * existing importers keep working unchanged.
 */
import { Invoice } from 'db/models'
import { mongoose } from 'db/connection'
import { numberPartsOf } from 'db/plugins/invoice-number-parts'
import {
  CONTINUOUS_PAD, getNextNumber, getNextContinuousNumber, getCurrentNumber, highestCounter, isContinuousSeries,
  ensureSequenceAtLeast, getDisplayPrefix, isLegalSeries, seriesFrozenSince, SeriesFrozenError, type SequenceOptions,
} from './sequence.service.js'
import {
  INVOICING_SEQUENCE_KEYS,
  LEGACY_DISPLAY_ALIASES,
  sequenceDefFor,
  sequenceGroupFor,
  resolveDefPrefix,
  type SequenceVariant,
} from './sequence-registry.js'

// Prefix rendered on the invoice number, derived from the sequences registry so the
// configuration page (/invoicing/configuration/sequences) stays the single source of truth.
export const TYPE_PREFIX: Record<string, string> = Object.fromEntries(
  (['cash_sale', 'proforma', 'offer', 'credit_note', 'debit_note'] as const)
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

/**
 * FR-20.81 (P3-6d): the refusal a document gets BEFORE it moves anything, while the series it would
 * be issued in waits for a lost site's last numbers. `getNextNumber` refuses too, but only at the
 * allocation, and the issuing paths reach it after their claim, their stock movement or their
 * placeholder insert: refused there, a draft keeps a dispatch it has no number for, and a storno's
 * claim outlives the request.
 */
export async function issuableRefusal(orgId: string, direction: string, type?: string): Promise<SeriesFrozenError | null> {
  if (!isLegalSeries(sequenceKeyFor(type || 'invoice', direction))) return null
  const since = await seriesFrozenSince(orgId)
  return since ? new SeriesFrozenError(String(orgId), since) : null
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
 * Every display prefix a counter renders for this org: the registry defaults, whatever the org
 * configured on the sequences page (so renaming a prefix doesn't hide existing numbers), and the
 * prefixes the counter rendered historically (CRN/DBN before the FR-01 merge: their suffixes came
 * from this counter, so they count toward its max).
 */
export async function seriesPrefixes(orgId: string, key: string): Promise<string[]> {
  const defs = INVOICING_SEQUENCE_KEYS.filter(e => e.prefix === key && e.variant === 'issued')
  if (!defs.length) return []
  return [...new Set([
    ...(await Promise.all(defs.map(async d => [d.defaultDisplay, await resolveDefPrefix(orgId, d)]))).flat(),
    ...(LEGACY_DISPLAY_ALIASES[key] || []),
  ])]
}

/**
 * How a series' numbers read. A yearly series: `<prefix>-<year>-<number>`, of ONE year. A
 * continuous one: `<prefix>-<number>`, and every yearly number issued before it became continuous,
 * of ANY year, because its running number goes on above all of them. Since #929 only the fallback
 * for documents without stored parts matches it on the numbers themselves (`unbackfilledMax`).
 */
function seriesPattern(prefixes: string[], year: number | null): RegExp {
  const head = `^(?:${prefixes.map(escapeRe).join('|')})-`
  return new RegExp(year === null ? `${head}(?:\\d{4}-)?(\\d+)$` : `${head}${year}-(\\d+)$`)
}

/**
 * #929: the same reading on a number's HEAD, what stands before its last dash (`numberPartsOf`). A number
 * matches `seriesPattern` exactly when the piece after its last dash is digits and its head passes this.
 * Yearly: `<prefix>-<year>`. Continuous: `<prefix>` or `<prefix>-<4 digits>`.
 */
function seriesHeadPattern(prefixes: string[], year: number | null): RegExp {
  const head = `^(?:${prefixes.map(escapeRe).join('|')})`
  return new RegExp(year === null ? `${head}(?:-\\d{4})?$` : `${head}-${year}$`)
}

/**
 * The running number a document number carries in a CONTINUOUS series, or null when the number is
 * not one of the series' (a draft's, another series', a number with letters in it).
 */
export async function continuousSuffixOf(orgId: string, key: string, number: unknown): Promise<number | null> {
  const prefixes = await seriesPrefixes(orgId, key)
  if (!prefixes.length) return null
  const parts = numberPartsOf(String(number ?? ''))
  return parts.numberSeq !== null && seriesHeadPattern(prefixes, null).test(parts.numberHead) ? parts.numberSeq : null
}

/** A continuous series' number: its prefix and ten digits, no year. */
export function continuousNumber(display: string, n: number): string {
  return `${display}-${String(n).padStart(CONTINUOUS_PAD, '0')}`
}

/**
 * The highest running number stored under any of `heads`: one index key per head
 * (`{orgId, numberHead, numberSeq: -1}`), however many documents the org has.
 */
async function storedMax(orgId: mongoose.Types.ObjectId, heads: string[]): Promise<number> {
  const tops = await Promise.all(heads.map(numberHead =>
    Invoice.findOne({ orgId, numberHead }, { _id: 0, numberSeq: 1 }).sort({ numberSeq: -1 }).lean().exec()))
  return tops.reduce((max, top) => Math.max(max, typeof top?.numberSeq === 'number' ? top.numberSeq : 0), 0)
}

/**
 * The heads of a continuous series that this org's documents carry: a distinct scan of the same index, one
 * entry per head the org has (its series, their years, its drafts'), never one per document.
 */
async function continuousHeads(orgId: mongoose.Types.ObjectId, prefixes: string[]): Promise<string[]> {
  const re = seriesHeadPattern(prefixes, null)
  const heads: unknown[] = await Invoice.distinct('numberHead', { orgId }).exec()
  return heads.filter((h): h is string => typeof h === 'string' && re.test(h))
}

/**
 * #929: the old scan of the numbers, for an org some of whose documents carry no stored parts. Those are the
 * documents written before the parts existed, until migration `0024-invoice-number-parts` gives them theirs
 * (production runs with `MIGRATIONS_AUTO=false`, so the code is live before the backfill), and any document a
 * writer stored raw without them. One read on the index tells whether the org has any (`numberHead: null`
 * matches a missing head, and every written head is a string): with none the scan does not run.
 *
 * With some, it is the scan exactly as it was, over every number of the org, so the answer is the scan's whatever
 * the stored parts say. ⚠ Not narrowed to the documents without parts: `numberHead: null` is not in the number's
 * index, so the narrowed scan FETCHED each such document, where this one reads the unique number index alone
 * (`docsExamined: 0`, #785). Until the backfill an org pays what it paid before, and nothing more.
 */
async function unbackfilledMax(orgId: mongoose.Types.ObjectId, prefixes: string[], year: number | null): Promise<number> {
  if (!(await Invoice.exists({ orgId, numberHead: null }))) return 0
  // The pattern ends in `-<digits>`, so the running number is the piece after the last dash. An aggregate casts nothing.
  const rows: Array<{ max?: number }> = await Invoice.aggregate([
    { $match: { orgId, invoiceNumber: { $regex: seriesPattern(prefixes, year) } } },
    { $project: { _id: 0, n: { $convert: { input: { $arrayElemAt: [{ $split: ['$invoiceNumber', '-'] }, -1] }, to: 'double', onError: 0, onNull: 0 } } } },
    { $group: { _id: null, max: { $max: '$n' } } },
  ]).exec()
  return Number(rows[0]?.max ?? 0)
}

/**
 * The highest running number already in use in the series `key` for `year`. Used to bootstrap `lastNumber`
 * when legacy rows (seeds, pre-refactor per-prefix counters, imports) have numbers above the counter.
 *
 * `everyYear`: the series is continuous. Its numbers carry no year, and the yearly ones issued
 * before it became continuous count whatever their year.
 *
 * #929: read from the stored running numbers (`numberHead` / `numberSeq`, `db/plugins/invoice-number-parts`),
 * a key or two per head. It used to scan every number of the org at each allocation and each time a form asked
 * for the next number: its keys grew with the org, and an issued sales document was re-planned every time,
 * about 18 µs per invoice of the org (#785). Documents with no stored parts yet are still read by their
 * numbers (`unbackfilledMax`), so the answer is the scan's before, during and after the backfill.
 */
export async function currentMaxSuffix(orgId: string, key: string, year: number, opts: { everyYear?: boolean } = {}): Promise<number> {
  const prefixes = await seriesPrefixes(orgId, key)
  if (!prefixes.length) return 0
  const oid = new mongoose.Types.ObjectId(String(orgId))
  const ofYear = opts.everyYear ? null : year
  const heads = ofYear === null ? await continuousHeads(oid, prefixes) : [...new Set(prefixes.map(p => `${p}-${ofYear}`))]
  const [stored, legacy] = await Promise.all([storedMax(oid, heads), unbackfilledMax(oid, prefixes, ofYear)])
  return Math.max(stored, legacy)
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

export async function getNextInvoiceNumber(orgId: string, direction: string, type?: string, opts?: SequenceOptions): Promise<string> {
  const t = type || 'invoice'
  const key = sequenceKeyFor(t, direction)
  const year = new Date().getFullYear()

  // A continuous series: no year, ten digits, on above every number of the series in any form
  // (the yearly ones issued before the switch, and the ones an import brought with it).
  if (await isContinuousSeries(orgId, key)) {
    const floor = await currentMaxSuffix(orgId, key, year, { everyYear: true })
    const n = await getNextContinuousNumber(orgId, key, floor, year, opts)
    const display = (await resolveDocPrefix(orgId, t, direction, 'issued')) || prefixFor(t, direction)
    return continuousNumber(display, n)
  }

  // Reconcile: ensure the shared counter has caught up with any pre-existing numbers in the
  // same prefix group (fixes legacy data where the per-prefix counter pre-dated SALES_DOC,
  // or where seeds inserted invoiceNumbers directly without bumping a counter).
  const minValue = await currentMaxSuffix(orgId, key, year)
  if (minValue > 0) await ensureSequenceAtLeast(orgId, key, year, minValue, opts)

  // Atomic $inc. Shared key → shared counter. The counter value is formatted with the
  // org's configured prefix (SALES_DOC=11 → "INV-2026-00011" or "CRN-2026-00011" etc.).
  const numberFromService = await getNextNumber(orgId, key, 5, year, opts)
  const seqPart = numberFromService.split('-').pop()!
  const display = (await resolveDocPrefix(orgId, t, direction, 'issued')) || prefixFor(t, direction)
  return `${display}-${year}-${seqPart}`
}

/**
 * The number the next issued document of a series would get, without drawing it: what a form shows
 * before the document is issued. The same reading as `getNextInvoiceNumber`, so the two agree.
 */
export async function peekNextInvoiceNumber(orgId: string, direction: string, type?: string): Promise<{ next: string; counter: number; prefix: string }> {
  const t = type || 'invoice'
  const key = sequenceKeyFor(t, direction)
  const year = new Date().getFullYear()
  const display = await resolveDisplayPrefix(orgId, prefixFor(t, direction), key)
  if (await isContinuousSeries(orgId, key)) {
    const counter = await highestCounter(orgId, key)
    const next = Math.max(counter, await currentMaxSuffix(orgId, key, year, { everyYear: true })) + 1
    return { next: continuousNumber(display, next), counter, prefix: display }
  }
  // For SALES_DOC keep the reconciliation behaviour aligned with allocate-time.
  const counter = await getCurrentNumber(orgId, key, year)
  const next = Math.max(counter, await currentMaxSuffix(orgId, key, year)) + 1
  return { next: `${display}-${year}-${String(next).padStart(5, '0')}`, counter, prefix: display }
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
