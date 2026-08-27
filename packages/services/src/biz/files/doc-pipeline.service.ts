import { DocFile, Warehouse } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import { analyzeDocuments, profileForKind, type AnalyzeContext } from '../doc-import/analyze.js'
import { commitDocuments } from '../doc-import/commit.js'
import { parseSpreadsheet } from '../doc-import/xlsx.js'
import type { ImportTarget, DocKind } from '../doc-import/types.js'
import { ocrDocument } from './doc-store.service.js'

/**
 * Files app — the OCR→analyze→commit orchestration. Thin wrappers over the existing doc-import
 * engine (analyzeDocuments / commitDocuments) keyed on a DocFile: pick the import target from the
 * DocFile's docType, feed the stored text (PDF) or parsed sheet (xlsx), persist the analysis, and
 * on commit book via the same tested path the CLI skills use. Nothing here is new booking logic.
 */

export function targetForDocType(docType: string): ImportTarget | null {
  if (docType === 'cash_register') return 'cash_sale'
  if (['goods_receipt', 'correction', 'transfer_note', 'issue_note', 'store_operations'].includes(docType)) return 'movement'
  if (docType === 'invoice') return 'sales_invoice' // direction refined inside analyze; a bill re-targets manually
  return null // store_availability → compare; unknown → not analyzable
}

const isXlsx = (name: string) => /\.xlsx?$/i.test(name)

/** OCR-if-needed → analyze via the engine → persist the mapped form + diff on the DocFile. */
export async function analyzeDocFile(orgId: string, userId: string, docFileId: string, context: AnalyzeContext = {}) {
  let doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  const target = targetForDocType(doc.docType)
  if (!target) throw new Error(`${doc.docType} is not analyzable`)

  const item: any = { fileId: String(doc.fileId), filename: doc.originalName }
  if (isXlsx(doc.originalName)) {
    const buf = Buffer.from(await Bun.file(doc.currentPath).arrayBuffer())
    item.parsed = await parseSpreadsheet(buf as any)
  } else {
    if (!doc.extractedText) { await ocrDocument(orgId, userId, docFileId); doc = (await DocFile.findOne({ orgId, _id: docFileId }))! }
    item.text = doc.extractedText
    item.profile = profileForKind(doc.docType as DocKind)
  }

  // The CLI skills always pass a warehouse; mirror that so a movement resolves even when the
  // document's printed „Склад" doesn't match a warehouse name. Caller's choice wins.
  const ctx: AnalyzeContext = { ...context }
  if (target === 'movement' && !ctx.warehouseId) {
    const whs: any[] = await Warehouse.find({ orgId, isActive: { $ne: false } }).select('_id isDefault').lean()
    const def = whs.find(w => w.isDefault) || whs[0]
    if (def) ctx.warehouseId = String(def._id)
  }

  const [analyzed] = await analyzeDocuments(orgId, target, [item], ctx)
  doc.analysis = {
    target, docKind: analyzed.docKind, direction: (analyzed as any).direction, uncertain: (analyzed as any).uncertain,
    duplicate: analyzed.duplicate, validation: (analyzed as any).validation,
    mapped: analyzed.mapped, extraMovements: (analyzed as any).extraMovements,
    diagnostics: analyzed.diagnostics, error: (analyzed as any).error,
  }
  doc.status = 'analyzed'
  await doc.save()
  createAuditEntry({ orgId, userId, action: 'analyze', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: [{ field: 'target', oldValue: null, newValue: target }, { field: 'docKind', oldValue: null, newValue: analyzed.docKind }, { field: 'lines', oldValue: null, newValue: (analyzed.diagnostics?.perLine || []).length }] })
  return { target, analyzed }
}

/** Commit the stored analysis via the engine (book stock / issue doc), stamp the DocFile. */
export async function commitDocFile(orgId: string, userId: string, docFileId: string, opts: { convert?: boolean; adjustStock?: boolean; allowDuplicate?: boolean } = {}) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  const a: any = doc.analysis
  if (!a?.mapped) throw new Error('Analyze the document first')
  const item = { fileId: String(doc.fileId), mapped: a.mapped, extraMovements: a.extraMovements, options: { convert: opts.convert ?? true, adjustStock: opts.adjustStock ?? true, createMissingProducts: true, allowDuplicate: opts.allowDuplicate ?? false } }
  const [result] = await commitDocuments(orgId, userId, a.target, [item])
  if (result?.ok) {
    doc.committedTarget = a.target === 'movement' ? 'movement' : 'invoice'
    if (result.id) doc.committedIds = [result.id as any]
    // Persist the idempotency markers so a later re-upload can find these movements to reconcile
    // against (the marker is stable per document; a docNumber substring is not — storeOperations
    // markers are date-based, PDF markers number-based).
    const newMarkers = [a.mapped?.marker, ...((a.extraMovements || []) as any[]).map((m) => m?.marker)].filter(Boolean) as string[]
    if (newMarkers.length) doc.markers = Array.from(new Set([...(doc.markers || []), ...newMarkers]))
    doc.status = 'committed'
    await doc.save()
    createAuditEntry({ orgId, userId, action: 'commit', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: [{ field: 'target', oldValue: null, newValue: a.target }, { field: 'id', oldValue: null, newValue: result.id }, { field: 'number', oldValue: null, newValue: result.issuedNumber || result.number }] })
  }
  return result
}
