import { DocFile, File as FileModel, type IDocFile, type DocType } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { createAuditEntry } from '../audit-log.service.js'
import { mkdir, readdir, rename, stat } from 'fs/promises'
import { extname } from 'path'
import { safeFileName, containedJoin } from './safe-path.js'
import { createHash } from 'crypto'
import ExcelJS from 'exceljs'
import { logger } from '../../logger/logger.js'
import { ocrExtract } from '../doc-import/ocr-client.js'
import { detectDocKind } from '../doc-import/detect.js'
import { runAndDumpCompare } from './compare-snapshot.service.js'
import { resolveStored, toStored } from './stored-path.js'
import { mirroredBlobFile, mirrorFileMissing, readsByContent } from '../replication/mirror-blobs.js'

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
const orgRoot = (orgId: string) => containedJoin(UP(), String(orgId), 'docs')
const dateDir = (orgId: string, date: string) => containedJoin(orgRoot(orgId), String(date))
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
  // PDFs: number = the numeric id, date resolved later by OCR.
  //
  // Strip a copy suffix first. Downloading the same export twice gives "invoicem_3000100975_1.pdf",
  // and stripping non-digits turns that into the number 30001009751 — a document that does not
  // exist. It gets its own DocFile row, so the checksum dedupe (keyed on {docType, docNumber})
  // never sees the byte-identical original, and the day carries a phantom extra document.
  // A PlusMinus number never has a separator inside it, so a trailing "_1" / "-2" / " (3)" is
  // always the operating system's, not the ERP's.
  const noCopySuffix = rest.replace(/[ _-]\(?\d{1,2}\)?$/, '')
  return { docType, docNumber: noCopySuffix.replace(/[^0-9]/g, '') || rest, docDate: null }
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
  /** New BYTES over an existing document: the content changed, so anything derived from it is void. */
  updated: boolean
  /** …and that document had already been booked, so the booking no longer matches what it says. */
  staleBooking: boolean
}

/**
 * The booking no longer matches the document it came from.
 *
 * "Already imported?" was decided by the idempotency marker alone, which says a document with this
 * NUMBER is booked — not that what is booked still matches what the document SAYS. A corrected
 * re-upload therefore read as a plain duplicate and its changes were never applied.
 *
 * Rows booked before `committedChecksum` existed cannot prove they are current, so any later
 * version counts as stale. Reconcile is a dry run that reports "no change" when there is none, so
 * offering it too often is cheap; missing it silently loses the correction.
 */
export function isStaleBooking(d: any): boolean {
  if (!(d?.committedIds || []).length) return false
  if (d.committedChecksum) return d.committedChecksum !== d.currentChecksum
  return (Number(d.version) || 1) > (Number(d.committedVersion) || 1)
}

/** Store one uploaded file: file it by date, version any prior copy, upsert DocFile, audit. */
export async function storeDocument(
  orgId: string,
  userId: string,
  file: { name: string; type: string; size: number; arrayBuffer: () => Promise<ArrayBuffer> },
  opts: { correlationId?: string; ip?: string; ua?: string; docDate?: string } = {},
): Promise<StoreResult> {
  // ⚠ FIRST, before `parseDocMeta` and before any path is built from it. `docNumber` falls
  // back to the raw filename when it carries no digits, and that value is later joined into a
  // path by `resolveCompareDump` — so an unsanitised name escapes through the derived field
  // even where it does not escape through `canonicalPath`.
  const safeName = safeFileName(file.name)
  const meta = parseDocMeta(safeName)
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
  const canonicalPath = containedJoin(dir, safeName)

  // `docType` is REFINED after upload — OCR turns a stokrazp `goods_receipt` into a
  // `correction` once it reads "2000 КОРЕКЦИЯ" — while parseDocMeta only ever sees the
  // filename. Keying the idempotency lookup on the filename-derived type alone misses the
  // refined row and stores a DUPLICATE, so match across the family the prefix can produce.
  const family = TYPE_FAMILY[meta.docType] ?? [meta.docType]
  const existing = await DocFile.findOne({ orgId, docType: { $in: family }, docNumber: meta.docNumber })

  // Identical re-upload → no-op (still audited so the attempt is visible).
  if (existing && existing.currentChecksum === checksum) {
    createAuditEntry({ orgId, userId, action: 'upload', module: 'files', entityType: 'DocFile', entityId: String(existing._id), entityName: safeName, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'result', oldValue: null, newValue: 'duplicate (identical checksum)' }] })
    return { docFile: existing, isNew: false, replacedVersion: null, duplicate: true, updated: false, staleBooking: isStaleBooking(existing) }
  }

  // Archive the current canonical copy before overwriting.
  let replacedVersion: number | null = null
  if (existing) {
    replacedVersion = existing.version
    try {
      const vdir = containedJoin(dateDir(orgId, existing.docDate), 'versions')
      await mkdir(vdir, { recursive: true })
      const prior = safeFileName(existing.originalName)
      const ext = extname(prior)
      const stamp = (existing.updatedAt ?? existing.uploadedAt ?? new Date()).toISOString().replace(/[:.]/g, '-')
      const archived = containedJoin(vdir, `${prior.slice(0, prior.length - ext.length)}_${stamp}${ext}`)
      const moved = await rename(resolveStored(existing.currentPath, orgId), archived).then(() => true, () => false) // tolerate a missing prior file
      // The previous upload's File row follows its bytes into versions/. Left alone it would name
      // the canonical path, which the new bytes are about to take (#180).
      if (moved && existing.fileId) {
        await FileModel.updateOne({ orgId, _id: existing.fileId } as any, { $set: { storagePath: toStored(archived) } })
      }
    } catch (e) { logger.warn({ orgId, err: (e as Error).message }, 'version-archive failed') }
  }

  await Bun.write(canonicalPath, buf)

  // FR-20.24 (P0b-8): rows store the path relative to the upload root.
  const storedPath = toStored(canonicalPath)
  const fileMeta = await FileModel.create({ orgId, uploadedBy: userId, originalName: safeName, storagePath: storedPath, storageProvider: 'local', mimeType: file.type, size: file.size, sha256: checksum, module: 'files' })

  let docFile: IDocFile
  if (existing) {
    existing.docDate = folder
    existing.originalName = safeName
    existing.currentPath = storedPath
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
    // These describe the PREVIOUS bytes. Left in place they are read as if they described the new
    // ones — `buildAnalyzeItem` reuses `extractedText` whenever it is set, so a corrected document
    // re-analyzed to exactly what it said before, the dedupe called it a duplicate, and the change
    // was invisible (stokrazp 3000016311: two line items renamed, 8000 units on the wrong products).
    existing.extractedText = undefined
    existing.analysis = undefined
    existing.compareSummary = undefined
    // committedIds / markers / committedChecksum are deliberately KEPT: they record what this
    // document has already booked, which is exactly what a reconcile needs to diff against.
    docFile = await existing.save()
    createAuditEntry({ orgId, userId, action: 'overwrite', module: 'files', entityType: 'DocFile', entityId: String(docFile._id), entityName: safeName, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'version', oldValue: replacedVersion, newValue: docFile.version }, { field: 'checksum', oldValue: null, newValue: checksum.slice(0, 12) }] })
  } else {
    docFile = await DocFile.create({ orgId, docType: meta.docType, docNumber: meta.docNumber, docDate: folder, originalName: safeName, currentPath: storedPath, currentChecksum: checksum, version: 1, mimeType: file.type, size: file.size, status: 'uploaded', fileId: fileMeta._id, uploadedBy: userId, uploadedAt: new Date() })
    createAuditEntry({ orgId, userId, action: 'upload', module: 'files', entityType: 'DocFile', entityId: String(docFile._id), entityName: safeName, correlationId: opts.correlationId, ipAddress: opts.ip, userAgent: opts.ua, changes: [{ field: 'docType', oldValue: null, newValue: meta.docType }, { field: 'docNumber', oldValue: null, newValue: meta.docNumber }] })
  }
  return { docFile, isNew: !existing, replacedVersion, duplicate: false, updated: !!existing, staleBooking: isStaleBooking(docFile) }
}

/**
 * The day a BATCH belongs to, read from the batch itself.
 *
 * A PlusMinus PDF carries no date in its filename, so on its own it can only go to `inbox` and
 * wait for OCR. But a day folder is uploaded whole, and the spreadsheets in it are named
 * `storeAvailability_20260914_223839.xlsx` / `salesAnalysis_...` — the date is right there, in
 * the same batch. Using it files the PDFs correctly on arrival instead of leaving a whole day in
 * `inbox` because whoever uploaded it left the (optional) date box empty. It stays provisional:
 * `assignDateAfterOcr` still re-dates each PDF to the Дата printed inside it.
 *
 * Only applied when every dated file in the batch agrees — a mixed-day drop keeps the old
 * behaviour rather than stamping one day onto another day's documents.
 */
export function batchDocDate(files: Array<{ name?: string }>): string | undefined {
  const dates = new Set<string>()
  for (const f of files) {
    const d = parseDocMeta(String(f?.name || '')).docDate
    if (d) dates.add(d)
  }
  return dates.size === 1 ? [...dates][0] : undefined
}

export async function storeDocuments(orgId: string, userId: string, files: any[], opts: { correlationId?: string; ip?: string; ua?: string; docDate?: string } = {}) {
  const results: (StoreResult & { name: string })[] = []
  // The caller's date wins; otherwise fall back to the one the batch names itself.
  const effective = { ...opts, docDate: opts.docDate ?? batchDocDate(files) }
  for (const f of files) {
    try { const r = await storeDocument(orgId, userId, f, effective); results.push({ ...r, name: f.name }) }
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
  // Derived, not stored: the list is where a stale booking has to be visible, otherwise a corrected
  // document sits among the committed ones looking finished.
  return { docFiles: docs.map(d => ({ ...d, staleBooking: isStaleBooking(d) })), total, page, size }
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

/**
 * Move a removed document's bytes out of the live tree into `docs/_deleted/<docDate>/`, stamped so
 * repeated deletions of the same number never collide. Nothing is unlinked — a deletion that turns
 * out to be wrong is recoverable from there. Returns the new path, or null if the file was missing.
 */
export async function trashDocumentFile(orgId: string, doc: { docDate: string; originalName: string; currentPath: string }): Promise<string | null> {
  const dir = containedJoin(orgRoot(orgId), '_deleted', String(doc.docDate))
  await mkdir(dir, { recursive: true })
  const name = safeFileName(doc.originalName)
  const ext = extname(name)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = containedJoin(dir, `${name.slice(0, name.length - ext.length)}_${stamp}${ext}`)
  try {
    await rename(resolveStored(doc.currentPath, orgId), dest)
    return dest
  } catch {
    return null // already gone, or on another device — the DocFile row still goes
  }
}

/** List archived versions on disk for a document (newest first). */
export async function getVersions(orgId: string, docFileId: string) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId }).lean()
  if (!doc) return { current: null, versions: [] as any[] }
  // FR-20.69 (P3-3): a mirror lists them from their rows; their bytes were never on this disk.
  if (await readsByContent(orgId)) return { current: { name: doc.originalName, path: doc.currentPath, version: doc.version }, versions: await mirroredVersions(orgId, doc) }
  const vdir = containedJoin(dateDir(orgId, doc.docDate), 'versions')
  let files: string[] = []
  try { files = await readdir(vdir) } catch { /* none yet */ }
  const base = doc.originalName.replace(/\.[^.]+$/, '')
  const versions = []
  for (const f of files.filter(f => f.startsWith(base + '_'))) {
    try { const s = await stat(containedJoin(vdir, f)); versions.push({ name: f, size: s.size, archivedAt: s.mtime }) } catch { /* skip */ }
  }
  versions.sort((a, b) => +new Date(b.archivedAt) - +new Date(a.archivedAt))
  return { current: { name: doc.originalName, path: doc.currentPath, version: doc.version }, versions }
}

/** A document's earlier versions as a mirror knows them: the `File` rows that followed their bytes into `versions/`. */
async function mirroredVersions(orgId: string, doc: any) {
  const prefix = `${toStored(containedJoin(dateDir(orgId, doc.docDate), 'versions'))}/`
  const base = doc.originalName.replace(/.[^.]+$/, '')
  // A range, not a regex: the names are Cyrillic, and the prefix is a literal.
  const rows: any[] = await FileModel.find({ orgId, storagePath: { $gte: prefix, $lt: `${prefix}￿` } }, { storagePath: 1, size: 1, updatedAt: 1 }).lean()
  return rows
    .map(r => ({ name: String(r.storagePath).slice(prefix.length), size: r.size, archivedAt: r.updatedAt }))
    .filter(v => !v.name.includes('/') && v.name.startsWith(base + '_'))
    .sort((a, b) => +new Date(b.archivedAt) - +new Date(a.archivedAt))
}

/**
 * FR-20.69 (P3-3): a download on global of an org homed on a master. The bytes are read by content
 * (the row's sha256), never where the row says: the row's path is the master's to choose. Global's
 * own copy from before a move is taken into the content store on the way, checked by its hash; a
 * document in an archive is read out of its unit, and nothing is written back.
 */
async function mirroredDownload(orgId: string, doc: any, versionName?: string): Promise<{ path?: string; bytes?: Uint8Array; name: string; mime: string }> {
  if (versionName) {
    const safe = safeFileName(versionName)
    const stored = toStored(containedJoin(dateDir(orgId, doc.docDate), 'versions', safe))
    const row: any = await FileModel.findOne({ orgId, storagePath: stored }, { sha256: 1 }).lean()
    const path = row ? await mirroredBlobFile(orgId, row.sha256, [stored]) : null
    if (!path) throw await mirrorFileMissing(orgId)
    return { path, name: safe, mime: doc.mimeType }
  }
  const held = await mirroredBlobFile(orgId, doc.currentChecksum, [doc.currentPath])
  if (held) return { path: held, name: doc.originalName, mime: doc.mimeType }
  if (doc.archived && doc.archiveRef) {
    const { ArchiveUnit } = await import('db/models')
    const { memberPathOf, readUnitMember } = await import('../archive/archive.service.js')
    const unit: any = await ArchiveUnit.findOne({ orgId, _id: doc.archiveRef }, { sha256: 1, path: 1 }).lean()
    const unitFile = unit ? await mirroredBlobFile(orgId, unit.sha256, unit.path ? [unit.path] : []) : null
    const bytes = unitFile ? await readUnitMember(unitFile, memberPathOf(doc)) : null
    // ⚠ Exactly the content the row names, or nothing: the unit is checked against its own checksums.
    if (bytes && createHash('sha256').update(bytes).digest('hex') === doc.currentChecksum) {
      return { bytes: new Uint8Array(bytes), name: doc.originalName, mime: doc.mimeType }
    }
  }
  throw await mirrorFileMissing(orgId)
}

/**
 * Resolve the on-disk path for a download (current canonical, or a named archived version). On a
 * mirror it may be the bytes themselves (a document read out of its archive unit), and an absent
 * file throws `MirrorFileMissing`, which says why.
 */
export async function resolveDownload(orgId: string, docFileId: string, versionName?: string): Promise<{ path?: string; bytes?: Uint8Array; name: string; mime: string } | null> {
  const doc = await DocFile.findOne({ orgId, _id: docFileId }).lean()
  if (!doc) return null
  if (await readsByContent(orgId)) return mirroredDownload(orgId, doc, versionName)
  if (versionName) {
    // ⚠ The previous `.replace(/[/\\]/g, '')` stripped separators but left `..` intact as a
    // whole segment, so the sanitiser passed the one input it existed to stop. `safeFileName`
    // rejects it outright and `containedJoin` re-checks the result it produces.
    const safe = safeFileName(versionName)
    const p = containedJoin(dateDir(orgId, doc.docDate), 'versions', safe)
    return { path: p, name: safe, mime: doc.mimeType }
  }
  // FR-13.41/13.42 (#24) — the bytes may be cold. Rehydrate the single member and carry on
  // returning the same shape.
  //
  // ⚠ Here, and not in the controller, because this is what EVERY download path already goes
  // through. Приложение 29 т. 16 requires archived data to stay reachable „през потребителски
  // интерфейс" — an archive the download route has to know about is one a future route will
  // forget about, and the symptom is a 404 on a fiscal document that the UI still lists.
  //
  // ⚠ Dynamic import: `archive.service` reaches for `zlib` streams and the archives tree, and
  // `doc-store` is imported by paths that never download anything.
  if ((doc as any).archived) {
    const { rehydrateDocFile } = await import('../archive/archive.service.js')
    const got = await rehydrateDocFile(orgId, docFileId)
    if (got) return { path: got.path, name: doc.originalName, mime: doc.mimeType }
  }
  return { path: resolveStored(doc.currentPath, orgId), name: doc.originalName, mime: doc.mimeType }
}

const exists = (p: string) => stat(p).then(() => true, () => false)

/**
 * Move a document's bytes to `dest`. True when they are there afterwards, including a retry that
 * finds the move already done. A move that fails is LOGGED and the document keeps its path: it
 * used to be swallowed, and the row then named a file that was never written (#180).
 */
async function moveToDateFolder(orgId: string, docFileId: string, currentPath: string, dest: string): Promise<boolean> {
  let src: string
  try { src = resolveStored(currentPath, orgId) } catch (e) {
    logger.warn({ orgId, docFileId, currentPath, err: (e as Error).message }, 'document path does not resolve; it keeps its path')
    return false
  }
  try {
    await rename(src, dest)
    return true
  } catch (e) {
    if (!(await exists(src)) && (await exists(dest))) return true // moved by an earlier attempt
    logger.warn({ orgId, docFileId, from: currentPath, to: dest, err: (e as Error).message }, 'could not move the document to its date folder; it keeps its path')
    return false
  }
}

/** Phase 2 hook: after OCR resolves a PDF's real date, move it out of inbox into docs/<date>/. */
export async function assignDateAfterOcr(orgId: string, docFileId: string, docDate: string, docType?: DocType) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc || doc.docDate === docDate) { if (doc && docType) { doc.docType = docType; await doc.save() } return doc }
  const dir = dateDir(orgId, docDate)
  await mkdir(dir, { recursive: true })
  const dest = containedJoin(dir, safeFileName(doc.originalName))
  if (await moveToDateFolder(orgId, docFileId, doc.currentPath, dest)) {
    doc.currentPath = toStored(dest)
    // The File row the document was uploaded as follows it. Before #180 it kept the inbox path,
    // which no longer held anything.
    if (doc.fileId) await FileModel.updateOne({ orgId, _id: doc.fileId } as any, { $set: { storagePath: doc.currentPath } })
  }
  doc.docDate = docDate
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
  const buf = Buffer.from(await Bun.file(resolveStored(doc.currentPath, orgId)).arrayBuffer())
  const ext = await ocrExtract(buf, doc.originalName, { orgId })
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
/**
 * The dumped diff for a snapshot, ready to hand over.
 *
 * The report is written beside the snapshot when the compare runs, but a day may have been
 * uploaded before that existed, or the file may simply be gone — so regenerate rather than 404.
 * Downloading a diff should never require remembering to run one first.
 */
export async function resolveCompareDump(orgId: string, userId: string, docFileId: string, format: 'txt' | 'csv'): Promise<{ name: string; body: string }> {
  const doc = await DocFile.findOne({ orgId, _id: docFileId }).lean()
  if (!doc) throw new Error('DocFile not found')
  if (doc.docType !== 'store_availability') throw new Error('Only a storeAvailability snapshot has a diff')
  // FR-20.69 (P3-3): a diff is made, and kept, beside the snapshot where the org lives. A mirror
  // has neither, and must write nothing.
  if (await readsByContent(orgId)) throw new Error("The diff is made on the organisation's server: open it there.")
  const name = `compare-${doc.docNumber}.${format}`
  const path = containedJoin(dateDir(orgId, doc.docDate), safeFileName(name))
  try {
    const f = Bun.file(path)
    if (await f.exists()) return { name, body: await f.text() }
  } catch { /* fall through and rebuild */ }
  const res = await runCompareForSnapshot(orgId, userId, docFileId)
  return { name, body: format === 'csv' ? res.csv : res.txt }
}

export async function runCompareForSnapshot(orgId: string, userId: string, docFileId: string) {
  const doc = await DocFile.findOne({ orgId, _id: docFileId })
  if (!doc) throw new Error('DocFile not found')
  if (doc.docType !== 'store_availability') throw new Error('Not a storeAvailability document')
  const onDisk = resolveStored(doc.currentPath, orgId)
  const buf = Buffer.from(await Bun.file(onDisk).arrayBuffer())
  const res = await runAndDumpCompare(orgId, onDisk, buf, doc.docNumber)
  doc.compareSummary = res.summary
  doc.committedTarget = 'compare'
  doc.status = 'committed'
  await doc.save()
  createAuditEntry({ orgId, userId, action: 'compare', module: 'files', entityType: 'DocFile', entityId: docFileId, entityName: doc.originalName, changes: Object.entries(res.summary).map(([field, newValue]) => ({ field, oldValue: null, newValue })) })
  return res
}

