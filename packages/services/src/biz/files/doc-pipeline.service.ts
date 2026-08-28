import { DocFile, Warehouse } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import { analyzeDocuments, profileForKind, type AnalyzeContext } from '../doc-import/analyze.js'
import { commitDocuments } from '../doc-import/commit.js'
import { parseSpreadsheet } from '../doc-import/xlsx.js'
import { mapWithConcurrency } from '../doc-import/ocr-client.js'
import type { ImportTarget, DocKind } from '../doc-import/types.js'
import { ocrDocument } from './doc-store.service.js'

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
const ANALYZE_CONCURRENCY = 4

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
  }
  return item
}

/** The persisted `analysis` sub-document from an AnalyzedDoc. */
function analysisRecord(target: ImportTarget, a: any) {
  return {
    target, docKind: a.docKind, direction: a.direction, uncertain: a.uncertain,
    duplicate: a.duplicate, validation: a.validation,
    mapped: a.mapped, extraMovements: a.extraMovements,
    diagnostics: a.diagnostics, error: a.error,
  }
}

/** Compact per-document result the batch UI shows in its review/selection step. */
function docSummary(doc: any, target: ImportTarget | null, a: any) {
  const perLine = a?.diagnostics?.perLine || []
  const matched = perLine.filter((l: any) => l.matched).length
  const warnings = a?.diagnostics?.warnings || []
  const error = a?.error
  const duplicate = !!a?.duplicate
  const alreadyCommitted = doc.status === 'committed' // a re-analyzed committed doc reuses its stale
  return {                                            // pre-commit analysis — never offer it for commit again
    docFileId: String(doc._id), docNumber: doc.docNumber, docType: doc.docType, originalName: doc.originalName,
    docDate: doc.docDate, target, docKind: a?.docKind, direction: a?.direction,
    matched, total: perLine.length, unmatched: perLine.length - matched,
    warnings, duplicate, committed: alreadyCommitted, uncertain: !!a?.uncertain, error,
    // Clean, not-yet-committed docs pre-select for commit; the user reviews warnings and can override.
    committable: !!a?.mapped && !error && !alreadyCommitted,
    recommended: !!a?.mapped && !error && !duplicate && !alreadyCommitted && perLine.length > 0 && matched === perLine.length,
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
  if (target === 'movement' && !ctx.warehouseId) ctx.warehouseId = await resolveDefaultWarehouseId(orgId)

  const [analyzed] = await analyzeDocuments(orgId, target, [item], ctx)
  doc.analysis = analysisRecord(target, analyzed) as any
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
  const docs: any[] = await DocFile.find({ orgId, _id: { $in: docFileIds } })
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
      const ctx: AnalyzeContext = target === 'movement' && defaultWh ? { warehouseId: defaultWh } : {}
      const [a] = await analyzeDocuments(orgId, target, [item], ctx)
      const record = analysisRecord(target, a)
      bulk.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { analysis: record, status: 'analyzed' } } } })
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
  if (result.id) set.committedIds = [result.id]
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
  // Preserve the caller's order.
  for (const id of docFileIds) {
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
