import { DocFile, Warehouse } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import { analyzeDocuments, profileForKind, type AnalyzeContext } from '../doc-import/analyze.js'
import { commitDocuments } from '../doc-import/commit.js'
import { parseSpreadsheet } from '../doc-import/xlsx.js'
import { mapWithConcurrency } from '../doc-import/ocr-client.js'
import type { ImportTarget, DocKind } from '../doc-import/types.js'
import { ocrDocument } from './doc-store.service.js'
import { draftFromLayoutText } from '../doc-import/parse-table.js'

/**
 * Files app — the OCR→analyze→commit orchestration. Thin wrappers over the existing doc-import
 * engine (analyzeDocuments / commitDocuments) keyed on a DocFile: pick the import target from the
 * DocFile's docType, feed the stored text (PDF) or parsed sheet (xlsx), persist the analysis, and
 * on commit book via the same tested path the CLI skills use. Nothing here is new booking logic.
 *
 * Batch variants (analyzeDocFilesBatch / commitDocFilesBatch) do the same per document but with
 * shared setup and no N+1: ONE `$in` load, the warehouse resolved ONCE, analysis persisted in a
 * single `bulkWrite`, and the sidecar-bound analyze phase run at bounded concurrency (the sidecar
 * spawns async, so concurrent /draft calls overlap — same 4-way the /extract endpoint uses).
 */

export function targetForDocType(docType: string): ImportTarget | null {
  if (docType === 'cash_register') return 'cash_sale'
  if (['goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations'].includes(docType)) return 'movement'
  if (docType === 'invoice') return 'sales_invoice' // direction refined inside analyze; a bill re-targets manually
  return null // store_availability → compare; unknown → not analyzable
}

const isXlsx = (name: string) => /\.xlsx?$/i.test(name)

/**
 * The order a day must be processed in, whatever order the client selected.
 *
 * Receipts come first because they CREATE the products an invoice then sells — book the invoice
 * first and its line finds no product. Transfers and write-offs follow, then the sales documents,
 * and the availability snapshot last of all: it is the reconciliation, so everything else has to
 * be in the ledger before it is compared against.
 */
const TYPE_ORDER: Record<string, number> = {
  goods_receipt: 1, correction: 1,
  transfer_note: 2, issue_note: 2,
  invoice: 3, cash_register: 3,
  store_operations: 4,
  store_availability: 5,
}
const typeOrder = (t: string | undefined) => TYPE_ORDER[t || ''] ?? 8

export function inProcessingOrder<T extends { docType?: string; docDate?: string; docNumber?: string }>(docs: T[]): T[] {
  return [...docs].sort((a, b) =>
    typeOrder(a.docType) - typeOrder(b.docType)
    || String(a.docDate || '').localeCompare(String(b.docDate || ''))
    || String(a.docNumber || '').localeCompare(String(b.docNumber || '')))
}
// Documents that take the deterministic fast path cost ~0.2 ms, so this only paces the few
// that still need the sidecar. Tunable because the ceiling is the OCR pod, not this process.
const ANALYZE_CONCURRENCY = Number(process.env.FILES_ANALYZE_CONCURRENCY) || 4

/** The org's default (movement) warehouse id, resolved once and reused across a batch. */
async function resolveDefaultWarehouseId(orgId: string): Promise<string | undefined> {
  const whs: any[] = await Warehouse.find({ orgId, isActive: { $ne: false } }).select('_id isDefault').lean()
  const def = whs.find((w) => w.isDefault) || whs[0]
  return def ? String(def._id) : undefined
}

/** Build the engine AnalyzeItem for a DocFile — OCR-if-needed for PDFs, parse the sheet for xlsx,
 *  carry the filename-derived kind hint. Returns the (possibly re-read) extractedText inline. */
async function buildAnalyzeItem(orgId: string, userId: string, doc: any): Promise<any> {
  const item: any = { fileId: String(doc.fileId), filename: doc.originalName }
  if (isXlsx(doc.originalName)) {
    const buf = Buffer.from(await Bun.file(doc.currentPath).arrayBuffer())
    item.parsed = await parseSpreadsheet(buf as any)
  } else {
    let text = doc.extractedText
    if (!text) { text = (await ocrDocument(orgId, userId, String(doc._id))).docFile.extractedText }
    item.text = text
    item.profile = profileForKind(doc.docType as DocKind)
    // The filename prefix is authoritative for these PlusMinus exports; pass it as a fallback so a
    // fragmented landscape title (СТОКОВА … РАЗПИСКА split across columns) doesn't defeat kind
    // detection. Content detection still wins, so a 2000 КОРЕКЦИЯ correction is caught.
    if (doc.docType !== 'unknown') item.kind = doc.docType as DocKind
    // Fast path: these PlusMinus exports have a fixed column layout, so the item table can be read
    // straight off the cached text — ~0.2 ms instead of a ~40 s model call, and every number is
    // checked against the document's own arithmetic. Refuses (→ null) rather than guess, and the
    // sidecar draft below is then used exactly as before.
    const parsed = draftFromLayoutText(text || '', (doc.docType || 'unknown') as DocKind)
    if (parsed) item.draft = parsed
  }
  return item
}

/** The persisted `analysis` sub-document from an AnalyzedDoc. */
function analysisRecord(target: ImportTarget, a: any, draftSource?: 'parsed' | 'llm') {
  return {
    target, draftSource, docKind: a.docKind, direction: a.direction, uncertain: a.uncertain,
    duplicate: a.duplicate, validation: a.validation,
    mapped: a.mapped, extraMovements: a.extraMovements,
    diagnostics: a.diagnostics, error: a.error,
  }
}

/**
 * Per-document result for the batch review step.
 *
 * The line detail is included, not just the counts: "46 of 49 matched" tells nobody WHICH line to
 * look at. Warnings are attributed to their line where the mapper quoted the description (the
 * quantity-reconciliation ones do), so the review table can point straight at the problem.
 */
function docSummary(doc: any, target: ImportTarget | null, a: any) {
  const perLine: any[] = a?.diagnostics?.perLine || []
  const matched = perLine.filter((l: any) => l.matched).length
  const warnings: string[] = a?.diagnostics?.warnings || []
  const error = a?.error
  const duplicate = !!a?.duplicate
  const alreadyCommitted = doc.status === 'committed' // a re-analyzed committed doc reuses its stale
                                                      // pre-commit analysis — never offer it again
  // Pair each diagnostic with the mapped line it produced. Index alignment is NOT safe: a movement
  // re-emits its lines as [...positive, ...negative] and an order-split invoice pushes several
  // lines for one diagnostic, so match on the source text and fall back to position.
  const mappedLines: any[] = a?.mapped?.lines || []
  const used = new Set<number>()
  const mappedFor = (d: any, i: number) => {
    const hit = mappedLines.findIndex((m: any, j: number) => !used.has(j) && (m.sourceText || m.productName || m.description) === d.sourceText)
    const j = hit >= 0 ? hit : (used.has(i) ? -1 : i)
    if (j >= 0) used.add(j)
    return mappedLines[j]
  }
  /** A warning that quotes this line's text belongs to this line. */
  const BLOCKING = /VERIFY before committing/i
  const lines = perLine.map((d: any, i: number) => {
    const m = mappedFor(d, i) || {}
    const mine = warnings.filter(w => d.sourceText && w.includes(`"${d.sourceText}"`))
    const severity = mine.some(w => BLOCKING.test(w)) ? 'error' : (mine.length || !d.matched) ? 'warning' : 'ok'
    return {
      index: i,
      sourceText: d.sourceText,
      matched: !!d.matched,
      matchedBy: d.matchedBy ?? null,
      productName: m.productName || m.description || d.candidateNew?.name || null,
      willCreate: !d.matched && !!d.candidateNew,
      quantity: m.quantity ?? null,
      unitPrice: m.unitPrice ?? m.unitCost ?? null,
      severity,
      messages: mine,
    }
  })
  const hasBlocking = !!error || warnings.some(w => BLOCKING.test(w)) || lines.some(l => l.severity === 'error')
  return {
    docFileId: String(doc._id), docNumber: doc.docNumber, docType: doc.docType, originalName: doc.originalName,
    docDate: doc.docDate, target, docKind: a?.docKind, direction: a?.direction,
    draftSource: a?.draftSource,
    matched, total: perLine.length, unmatched: perLine.length - matched,
    warnings, duplicate, committed: alreadyCommitted, uncertain: !!a?.uncertain, error,
    lines, hasBlocking,
    committable: !!a?.mapped && !error && !alreadyCommitted,
    // Pre-select only what is genuinely clean. Matching every line is not enough on its own: a
    // document can match perfectly and still carry a "VERIFY before committing" quantity warning.
    recommended: !!a?.mapped && !error && !duplicate && !alreadyCommitted && !hasBlocking
      && perLine.length > 0 && matched === perLine.length,
  }
}

/** OCR-if-needed → analyze via the engine → persist the mapped form + diff on the DocFile. */
export async function analyzeDocFile(orgId: string, userId: string, docFileId: string, context: AnalyzeContext = {}) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  const target = targetForDocType(doc.docType)
  if (!target) throw new Error(`${doc.docType} is not analyzable`)

  const item = await buildAnalyzeItem(orgId, userId, doc)
  const ctx: AnalyzeContext = { ...context }
  // EVERY target needs a warehouse: invoice/cash-sale lines without one make
  // createInvoiceStockMovement a silent no-op (document issued, stock never dispatched).
  if (!ctx.warehouseId) ctx.warehouseId = await resolveDefaultWarehouseId(orgId)

  const [analyzed] = await analyzeDocuments(orgId, target, [item], ctx)
  doc.analysis = analysisRecord(target, analyzed, item.draft ? 'parsed' : 'llm') as any
  doc.status = 'analyzed'
  await doc.save()
  createAuditEntry({ orgId, userId, action: 'analyze', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: [{ field: 'target', oldValue: null, newValue: target }, { field: 'docKind', oldValue: null, newValue: analyzed.docKind }, { field: 'lines', oldValue: null, newValue: (analyzed.diagnostics?.perLine || []).length }] })
  return { target, analyzed }
}

/**
 * Batch analyze: one `$in` load, warehouse resolved once, per-doc analyze at 4-way concurrency
 * (the sidecar /draft is I/O-bound and spawns async), analysis persisted in ONE bulkWrite. Returns
 * a compact summary per document for the review/selection step. Already-analyzed docs are reused
 * unless `force`. Never books — that is `commitDocFilesBatch`.
 */
export async function analyzeDocFilesBatch(
  orgId: string, userId: string, docFileIds: string[],
  opts: { force?: boolean } = {},
  onProgress?: (done: number, total: number, label: string) => void,
) {
  const docs: any[] = inProcessingOrder(await DocFile.find({ orgId, _id: { $in: docFileIds } }))
  const defaultWh = await resolveDefaultWarehouseId(orgId)
  const total = docs.length
  let done = 0
  const bulk: any[] = []

  const results = await mapWithConcurrency(docs, ANALYZE_CONCURRENCY, async (doc) => {
    const target = targetForDocType(doc.docType)
    try {
      if (!target) return docSummary(doc, null, { error: `${doc.docType} is not analyzable` })
      // Reuse a prior analysis unless forced — skips the ~50s sidecar draft.
      if (!opts.force && doc.status !== 'uploaded' && (doc.analysis as any)?.mapped) {
        return { ...docSummary(doc, target, doc.analysis), reused: true }
      }
      const item = await buildAnalyzeItem(orgId, userId, doc)
      const ctx: AnalyzeContext = defaultWh ? { warehouseId: defaultWh } : {}
      const [a] = await analyzeDocuments(orgId, target, [item], ctx)
      const record = analysisRecord(target, a, item.draft ? 'parsed' : 'llm')
      // Never walk a COMMITTED document back to 'analyzed': it is already booked, and showing it
      // as pending invites a second commit. Re-analysis refreshes the analysis, not the state.
      const nextStatus = doc.status === 'committed' ? 'committed' : 'analyzed'
      bulk.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { analysis: record, status: nextStatus } } } })
      createAuditEntry({ orgId, userId, action: 'analyze', module: 'files', entityType: 'DocFile', entityId: String(doc._id), entityName: doc.originalName, changes: [{ field: 'docKind', oldValue: null, newValue: a.docKind }, { field: 'lines', oldValue: null, newValue: (a.diagnostics?.perLine || []).length }] })
      return docSummary(doc, target, a)
    } catch (e: any) {
      return docSummary(doc, target, { error: String(e?.message || e) })
    } finally {
      onProgress?.(++done, total, doc.docNumber)
    }
  })

  if (bulk.length) await DocFile.bulkWrite(bulk)
  return results
}

/** The engine CommitItem for a DocFile's stored analysis. */
function commitItemFor(doc: any, opts: { convert?: boolean; adjustStock?: boolean; allowDuplicate?: boolean }) {
  const a: any = doc.analysis
  return {
    fileId: String(doc.fileId), mapped: a.mapped, extraMovements: a.extraMovements,
    options: { convert: opts.convert ?? true, adjustStock: opts.adjustStock ?? true, createMissingProducts: true, allowDuplicate: opts.allowDuplicate ?? false },
  }
}

/** The DocFile stamp after a successful commit (returns a bulkWrite op + fires the audit entry). */
function stampCommitted(orgId: string, userId: string, doc: any, result: any) {
  const a: any = doc.analysis
  const target: ImportTarget = a.target
  const newMarkers = [a.mapped?.marker, ...((a.extraMovements || []) as any[]).map((m) => m?.marker)].filter(Boolean) as string[]
  const set: any = { committedTarget: target === 'movement' ? 'movement' : 'invoice', status: 'committed' }
  const ids = ((result.ids?.length ? result.ids : [result.id]) as (string | undefined)[]).filter(Boolean) as string[]
  if (ids.length) set.committedIds = ids
  if (newMarkers.length) set.markers = Array.from(new Set([...(doc.markers || []), ...newMarkers]))
  createAuditEntry({ orgId, userId, action: 'commit', module: 'files', entityType: 'DocFile', entityId: String(doc._id), entityName: doc.originalName, changes: [{ field: 'target', oldValue: null, newValue: target }, { field: 'id', oldValue: null, newValue: result.id }, { field: 'number', oldValue: null, newValue: result.issuedNumber || result.number }] })
  return { updateOne: { filter: { _id: doc._id }, update: { $set: set } } }
}

/** Commit the stored analysis via the engine (book stock / issue doc), stamp the DocFile. */
export async function commitDocFile(orgId: string, userId: string, docFileId: string, opts: { convert?: boolean; adjustStock?: boolean; allowDuplicate?: boolean } = {}) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  const a: any = doc.analysis
  if (!a?.mapped) throw new Error('Analyze the document first')
  const [result] = await commitDocuments(orgId, userId, a.target, [commitItemFor(doc, opts)])
  if (result?.ok) await DocFile.bulkWrite([stampCommitted(orgId, userId, doc, result)])
  return result
}

/**
 * Batch OCR — extract text for every selected PDF that has none yet, in the canonical order.
 * Analyze does this on demand anyway; this exists so the step can be run (and watched) on its own.
 */
export async function ocrDocFilesBatch(
  orgId: string, userId: string, docFileIds: string[],
  opts: { force?: boolean } = {},
  onProgress?: (done: number, total: number, label: string) => void,
) {
  const docs = inProcessingOrder(await DocFile.find({ orgId, _id: { $in: docFileIds } }))
  const total = docs.length
  let done = 0
  const results = await mapWithConcurrency(docs, ANALYZE_CONCURRENCY, async (doc: any) => {
    try {
      if (isXlsx(doc.originalName)) return { docFileId: String(doc._id), docNumber: doc.docNumber, skipped: true, reason: 'spreadsheet' }
      if (doc.extractedText && !opts.force) return { docFileId: String(doc._id), docNumber: doc.docNumber, skipped: true, reason: 'already extracted', chars: doc.extractedText.length }
      const r = await ocrDocument(orgId, userId, String(doc._id))
      return { docFileId: String(doc._id), docNumber: doc.docNumber, ok: true, chars: (r.docFile.extractedText || '').length, docDate: r.docFile.docDate, docType: r.docFile.docType }
    } catch (e: any) {
      return { docFileId: String(doc._id), docNumber: doc.docNumber, ok: false, error: String(e?.message || e) }
    } finally {
      onProgress?.(++done, total, doc.docNumber)
    }
  })
  return results
}

/**
 * Batch commit: one `$in` load, then commit each selected doc's stored analysis. Runs SERIALLY —
 * the sidecar isn't involved (fast), and serial keeps concurrent StockLevel updates from racing
 * when two documents touch the same product. DocFile stamps land in ONE bulkWrite.
 */
export async function commitDocFilesBatch(
  orgId: string, userId: string, docFileIds: string[],
  opts: { convert?: boolean; adjustStock?: boolean; allowDuplicate?: boolean } = {},
  onProgress?: (done: number, total: number, label: string) => void,
) {
  const docs: any[] = await DocFile.find({ orgId, _id: { $in: docFileIds } })
  const byId = new Map(docs.map((d) => [String(d._id), d]))
  const total = docFileIds.length
  const results: any[] = []
  const bulk: any[] = []
  let done = 0
  // Commit in the canonical order, not the order the client happened to send: a receipt has to
  // create its products before an invoice that sells them is booked.
  const ordered = inProcessingOrder(docFileIds.map(id => byId.get(String(id)) ?? { _id: id })) as any[]
  for (const doc0 of ordered) {
    const id = String(doc0._id)
    const doc = byId.get(String(id))
    try {
      if (!doc) { results.push({ docFileId: String(id), ok: false, error: 'DocFile not found' }); continue }
      const a: any = doc.analysis
      if (!a?.mapped) { results.push({ docFileId: String(id), docNumber: doc.docNumber, ok: false, error: 'Analyze the document first' }); continue }
      const [result] = await commitDocuments(orgId, userId, a.target, [commitItemFor(doc, opts)])
      if (result?.ok) bulk.push(stampCommitted(orgId, userId, doc, result))
      results.push({ docFileId: String(id), docNumber: doc.docNumber, ok: !!result?.ok, id: result?.id, number: result?.number, issuedNumber: result?.issuedNumber, error: result?.error })
    } catch (e: any) {
      results.push({ docFileId: String(id), docNumber: doc?.docNumber, ok: false, error: String(e?.message || e) })
    } finally {
      onProgress?.(++done, total, doc?.docNumber || String(id))
    }
  }
  if (bulk.length) await DocFile.bulkWrite(bulk)
  return results
}
