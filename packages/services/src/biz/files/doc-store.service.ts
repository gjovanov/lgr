import { DocFile, File as FileModel, type IDocFile, type DocType } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { createAuditEntry } from '../audit-log.service.js'
import { mkdir, readdir, rename, stat } from 'fs/promises'
import { join, extname } from 'path'
import { createHash } from 'crypto'
import ExcelJS from 'exceljs'
import { logger } from '../../logger/logger.js'
import { ocrExtract } from '../doc-import/ocr-client.js'
import { detectDocKind } from '../doc-import/detect.js'
import { runAndDumpCompare } from './compare-snapshot.service.js'

/**
 * Files app — the PV-backed, versioned, audited document store. Extends the (previously
 * dormant) file.service.ts date-folder scheme with:
 *   - a canonical path per document:  <UPLOAD_DIR>/<orgId>/docs/<docDate>/<originalName>
 *   - version history on re-upload:    …/<docDate>/versions/<name>_<prevUploadIso>.<ext>
 *   - checksum idempotency (identical re-upload = no-op)
 *   - a DocFile row keyed {orgId, docType, docNumber} + an AuditLog trail on every write
 *
 * xlsx exports (salesAnalysis / storeAvailability / storeOperations) carry their date in the
 * filename and are filed immediately; PDFs land in `docs/inbox/` and are moved to their real
 * date folder by the OCR step (assignDateAfterOcr) once the Дата header is read.
 */

const UP = () => config.upload.dir
const orgRoot = (orgId: string) => join(UP(), orgId, 'docs')
const dateDir = (orgId: string, date: string) => join(orgRoot(orgId), date)
const nowIso = () => new Date().toISOString().replace(/[:.]/g, '-')

/** Prefix → docType. */
const PREFIX_TYPE: Record<string, DocType> = {
  invoicem: 'invoice',
  salesAnalysis: 'cash_register',
  stokrazp: 'goods_receipt', // may become 'correction' once OCR sees "2000 КОРЕКЦИЯ"
  sklrazp: 'transfer_note',
  sklisk: 'issue_note',
  storeOperations: 'store_operations',
  storeAvailability: 'store_availability',
  invoiceProf: 'proforma',
  docJournalReport: 'journal_register',
}
/** Types one filename prefix can end up as, once OCR refines what the prefix could not know. */
const TYPE_FAMILY: Partial<Record<DocType, DocType[]>> = {
  goods_receipt: ['goods_receipt', 'correction'],
  correction: ['goods_receipt', 'correction'],
}
const XLSX_TYPES = new Set<DocType>(['cash_register', 'store_operations', 'store_availability', 'journal_register'])

export interface DocMeta { docType: DocType; docNumber: string; docDate: string | null }

/** Derive {docType, docNumber, docDate?} from the export filename. PDFs get docDate=null (→ inbox). */
export function parseDocMeta(filename: string): DocMeta {
  const base = filename.replace(/\.[^.]+$/, '')
  const m = base.match(/^([A-Za-z]+)_(.+)$/)
  const prefix = m?.[1] ?? ''
  const rest = m?.[2] ?? base
  const docType = PREFIX_TYPE[prefix] ?? 'unknown'
  if (XLSX_TYPES.has(docType)) {
    // salesAnalysis_20260813_172956 → number = the stamp, date = YYYY-MM-DD
    const d = rest.match(/^(\d{4})(\d{2})(\d{2})/)
    return { docType, docNumber: rest, docDate: d ? `${d[1]}-${d[2]}-${d[3]}` : null }
  }
  // PDFs: number = the numeric id, date resolved later by OCR
  return { docType, docNumber: rest.replace(/[^0-9]/g, '') || rest, docDate: null }
}

const sha256 = (buf: ArrayBuffer | Buffer) => createHash('sha256').update(Buffer.from(buf as any)).digest('hex')

/**
 * The business period printed INSIDE an xlsx export (`Период: DD.MM.YYYY - …`).
 * The filename stamp is the EXPORT moment, which for a morning-after export
 * (salesAnalysis / docJournalReport pulled the next day) is the wrong business day —
 * e.g. salesAnalysis_20260826_195818.xlsx holds the 2026-08-13 register.
 */
async function readXlsxPeriodDate(buf: ArrayBuffer): Promise<string | null> {
  try {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(Buffer.from(buf as any))
    const ws = wb.worksheets[0]
    if (!ws) return null
    for (let r = 1; r <= Math.min(12, ws.rowCount); r++) {
      const row = ws.getRow(r)
      for (let c = 1; c <= 8; c++) {
        const m = String(row.getCell(c).text ?? '').match(/(?:Период|ПЕРИОД)\s*:?\s*(\d{2})\.(\d{2})\.(\d{4})/)
        if (m) return `${m[3]}-${m[2]}-${m[1]}`
      }
    }
    return null
  } catch { return null }
}

export interface StoreResult {
  docFile: IDocFile
  isNew: boolean
  replacedVersion: number | null // the version number that was archived, or null
  duplicate: boolean             // identical checksum — nothing written
}

/** Store one uploaded file: file it by date, version any prior copy, upsert DocFile, audit. */
export async function storeDocument(
  orgId: string,
  userId: string,
  file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
  opts: { correlationId?: string; ip?: string; ua?: string; docDate?: string } = {},
): Promise<StoreResult> {
  const meta = parseDocMeta(file.name)
  const buf = await file.arrayBuffer()
  const checksum = sha256(buf)
  // Date precedence: caller-supplied (the UI knows which day folder it is uploading) → the
  // BUSINESS PERIOD read from inside the xlsx → the filename stamp → inbox.
  if (XLSX_TYPES.has(meta.docType)) {
    const period = await readXlsxPeriodDate(buf)
    if (period) meta.docDate = period
  }
  const folder = opts.docDate ?? meta.docDate ?? 'inbox'
  const dir = dateDir(orgId, folder)
  await mkdir(dir, { recursive: true })
  const canonicalPath = join(dir, file.name)

  // `docType` is REFINED after upload — OCR turns a stokrazp `goods_receipt` into a
  // `correction` once it reads "2000 КОРЕКЦИЯ" — while parseDocMeta only ever sees the
  // filename. Keying the idempotency lookup on the filename-derived type alone misses the
  // refined row and stores a DUPLICATE, so match across the family the prefix can produce.
  const family = TYPE_FAMILY[meta.docType] ?? [meta.docType]
  const existing = await DocFile.findOne({ orgId, docType: { $in: family }, docNumber: meta.docNumber })

  // Identical re-upload → no-op (still audited so the attempt is visible).
  if (existing && existing.currentChecksum === checksum) {
    createAuditEntry({ orgId, userId, action: 'upload', module: 'files', entityType: 'DocFile', entityId: String(existing._id), entityName: file.name, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'result', oldValue: null, newValue: 'duplicate (identical checksum)' }] })
    return { docFile: existing, isNew: false, replacedVersion: null, duplicate: true }
  }

  // Archive the current canonical copy before overwriting.
  let replacedVersion: number | null = null
  if (existing) {
    replacedVersion = existing.version
    try {
      const vdir = join(dateDir(orgId, existing.docDate), 'versions')
      await mkdir(vdir, { recursive: true })
      const ext = extname(existing.originalName)
      const stamp = (existing.updatedAt ?? existing.uploadedAt ?? new Date()).toISOString().replace(/[:.]/g, '-')
      const archived = join(vdir, `${existing.originalName.slice(0, existing.originalName.length - ext.length)}_${stamp}${ext}`)
      await rename(existing.currentPath, archived).catch(() => {}) // tolerate a missing prior file
    } catch (e) { logger.warn({ orgId, err: (e as Error).message }, 'version-archive failed') }
  }

  await Bun.write(canonicalPath, buf)

  const fileMeta = await FileModel.create({ orgId, uploadedBy: userId, originalName: file.name, storagePath: canonicalPath, storageProvider: 'local', mimeType: file.type, size: file.size, module: 'files' })

  let docFile: IDocFile
  if (existing) {
    existing.docDate = folder
    existing.originalName = file.name
    existing.currentPath = canonicalPath
    existing.currentChecksum = checksum
    existing.version += 1
    existing.mimeType = file.type
    existing.size = file.size
    existing.status = 'uploaded'
    existing.fileId = fileMeta._id
    existing.uploadedBy = userId as any
    existing.uploadedAt = new Date()
    existing.isActive = true
    existing.deactivatedAt = undefined
    docFile = await existing.save()
    createAuditEntry({ orgId, userId, action: 'overwrite', module: 'files', entityType: 'DocFile', entityId: String(docFile._id), entityName: file.name, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'version', oldValue: replacedVersion, newValue: docFile.version }, { field: 'checksum', oldValue: null, newValue: checksum.slice(0, 12) }] })
  } else {
    docFile = await DocFile.create({ orgId, docType: meta.docType, docNumber: meta.docNumber, docDate: folder, originalName: file.name, currentPath: canonicalPath, currentChecksum: checksum, version: 1, mimeType: file.type, size: file.size, status: 'uploaded', fileId: fileMeta._id, uploadedBy: userId, uploadedAt: new Date() })
    createAuditEntry({ orgId, userId, action: 'upload', module: 'files', entityType: 'DocFile', entityId: String(docFile._id), entityName: file.name, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'docType', oldValue: null, newValue: meta.docType }, { field: 'docNumber', oldValue: null, newValue: meta.docNumber }] })
  }
  return { docFile, isNew: !existing, replacedVersion, duplicate: false }
}

export async function storeDocuments(orgId: string, userId: string, files: any[], opts: { correlationId?: string; ip?: string; ua?: string; docDate?: string } = {}) {
  const results: (StoreResult & { name: string })[] = []
  for (const f of files) {
    try { const r = await storeDocument(orgId, userId, f, opts); results.push({ ...r, name: f.name }) }
    catch (e) { logger.error({ orgId, name: f?.name, err: (e as Error).message }, 'storeDocument failed'); throw e }
  }
  return results
}

export async function listDocuments(orgId: string, filters: { docType?: string; docDate?: string; status?: string; search?: string; page?: number; size?: number } = {}) {
  const q: Record<string, any> = { orgId, isActive: true }
  if (filters.docType) q.docType = filters.docType
  if (filters.docDate) q.docDate = filters.docDate
  if (filters.status) q.status = filters.status
  if (filters.search) q.docNumberLower = { $regex: String(filters.search).replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg') }
  const page = filters.page ?? 0, size = filters.size ?? 50
  const [docs, total] = await Promise.all([
    // The two bulky blobs are never read from a LIST row — the review table sources its per-line
    // detail from the analyze response, not from here — and together they are ~2/3 of the payload.
    DocFile.find(q, { extractedText: 0, 'analysis.mapped': 0 })
      .sort({ docDate: -1, docType: 1, docNumber: 1 }).skip(page * size).limit(size).lean(),
    DocFile.countDocuments(q),
  ])
  return { docFiles: docs, total, page, size }
}

/**
 * Per-date roll-up for the grouped Documents view — ONE aggregation, no N+1. Returns one row per
 * `docDate` with the document count and a status breakdown, newest date first. `aggregate()` bypasses
 * the tenant plugin, so orgId is matched explicitly (as an ObjectId).
 */
export async function listDatesSummary(orgId: string, filters: { docType?: string; status?: string; search?: string } = {}) {
  const match: Record<string, any> = { orgId: new mongoose.Types.ObjectId(orgId), isActive: true }
  if (filters.docType) match.docType = filters.docType
  if (filters.status) match.status = filters.status
  if (filters.search) match.docNumberLower = { $regex: String(filters.search).replace(/\s+/g, ' ').trim().toLocaleLowerCase('bg') }
  const rows = await DocFile.aggregate([
    { $match: match },
    { $group: {
      _id: '$docDate',
      total: { $sum: 1 },
      uploaded: { $sum: { $cond: [{ $eq: ['$status', 'uploaded'] }, 1, 0] } },
      analyzed: { $sum: { $cond: [{ $eq: ['$status', 'analyzed'] }, 1, 0] } },
      committed: { $sum: { $cond: [{ $eq: ['$status', 'committed'] }, 1, 0] } },
    } },
    { $sort: { _id: -1 } },
  ])
  return { dates: rows.map((r: any) => ({ docDate: r._id, total: r.total, uploaded: r.uploaded, analyzed: r.analyzed, committed: r.committed })) }
}

/** List archived versions on disk for a document (newest first). */
export async function getVersions(orgId: string, docFileId: string) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId }).lean()
  if (!doc) return { current: null, versions: [] as any[] }
  const vdir = join(dateDir(orgId, doc.docDate), 'versions')
  let files: string[] = []
  try { files = await readdir(vdir) } catch { /* none yet */ }
  const base = doc.originalName.replace(/\.[^.]+$/, '')
  const versions = []
  for (const f of files.filter(f => f.startsWith(base + '_'))) {
    try { const s = await stat(join(vdir, f)); versions.push({ name: f, size: s.size, archivedAt: s.mtime }) } catch { /* skip */ }
  }
  versions.sort((a, b) => +new Date(b.archivedAt) - +new Date(a.archivedAt))
  return { current: { name: doc.originalName, path: doc.currentPath, version: doc.version }, versions }
}

/** Resolve the on-disk path for a download (current canonical, or a named archived version). */
export async function resolveDownload(orgId: string, docFileId: string, versionName?: string): Promise<{ path: string; name: string; mime: string } | null> {
  const doc = await DocFile.findOne({ orgId, _id: docFileId }).lean()
  if (!doc) return null
  if (versionName) {
    const p = join(dateDir(orgId, doc.docDate), 'versions', versionName.replace(/[/\\]/g, ''))
    return { path: p, name: versionName, mime: doc.mimeType }
  }
  return { path: doc.currentPath, name: doc.originalName, mime: doc.mimeType }
}

/** Phase 2 hook: after OCR resolves a PDF's real date, move it out of inbox into docs/<date>/. */
export async function assignDateAfterOcr(orgId: string, docFileId: string, docDate: string, docType?: DocType) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc || doc.docDate === docDate) { if (doc && docType) { doc.docType = docType; await doc.save() } return doc }
  const dir = dateDir(orgId, docDate)
  await mkdir(dir, { recursive: true })
  const dest = join(dir, doc.originalName)
  await rename(doc.currentPath, dest).catch(() => {})
  doc.docDate = docDate
  doc.currentPath = dest
  if (docType) doc.docType = docType
  doc.status = 'extracted'
  return doc.save()
}

/** OCR a stored PDF → text, refine docType (goods_receipt→correction etc.), resolve the Дата,
 *  and move it out of inbox into docs/<date>/. xlsx are skipped (already dated + parsed). */
export async function ocrDocument(orgId: string, userId: string, docFileId: string) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  if (/\.xlsx?$/i.test(doc.originalName)) return { docFile: doc, skipped: true, method: 'xlsx', chars: 0 }
  const buf = Buffer.from(await Bun.file(doc.currentPath).arrayBuffer())
  const ext = await ocrExtract(buf, doc.originalName)
  const text = ext.text || ''
  const kind = detectDocKind(text)
  const dateM = text.match(/(\d{2})\.(\d{2})\.(20\d{2})/)
  const docDate = dateM ? `${dateM[3]}-${dateM[2]}-${dateM[1]}` : doc.docDate
  // The FILENAME can be more specific than the text: an invoiceProf reads exactly like an
  // invoice, so an unguarded refinement turns a proforma into a bookable sales invoice. Accept
  // OCR's kind only when it refines within the family the prefix allows (goods_receipt →
  // correction) or when the prefix told us nothing.
  const family = TYPE_FAMILY[doc.docType as DocType]
  const refines = !!kind && kind !== 'unknown' &&
    (doc.docType === 'unknown' || kind === doc.docType || !!family?.includes(kind as DocType))
  const newType = refines ? kind : doc.docType
  await assignDateAfterOcr(orgId, docFileId, docDate, newType as DocType)
  const fresh = await DocFile.findOne({ orgId, _id: docFileId })
  if (fresh) { fresh.extractedText = text.slice(0, 200000); fresh.status = 'extracted'; await fresh.save() }
  createAuditEntry({ orgId, userId, action: 'ocr', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: [{ field: 'docType', oldValue: doc.docType, newValue: newType }, { field: 'docDate', oldValue: doc.docDate, newValue: docDate }, { field: 'chars', oldValue: null, newValue: text.length }] })
  return { docFile: fresh || doc, skipped: false, method: ext.method, chars: text.length, docKind: kind, docDate }
}

/** Run + dump the storeAvailability auto-diff for a stored snapshot; persist the summary. */
export async function runCompareForSnapshot(orgId: string, userId: string, docFileId: string) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  if (doc.docType !== 'store_availability') throw new Error('Not a storeAvailability document')
  const buf = Buffer.from(await Bun.file(doc.currentPath).arrayBuffer())
  const res = await runAndDumpCompare(orgId, doc.currentPath, buf, doc.docNumber)
  doc.compareSummary = res.summary
  doc.committedTarget = 'compare'
  doc.status = 'committed'
  await doc.save()
  createAuditEntry({ orgId, userId, action: 'compare', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: Object.entries(res.summary).map(([field, newValue]) => ({ field, oldValue: null, newValue })) })
  return res
}

