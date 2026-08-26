import { DocFile, File as FileModel, type IDocFile, type DocType } from 'db/models'
import { config } from 'config'
import { createAuditEntry } from '../audit-log.service.js'
import { mkdir, readdir, rename, stat } from 'fs/promises'
import { join, extname } from 'path'
import { createHash } from 'crypto'
import { logger } from '../../logger/logger.js'

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
}
const XLSX_TYPES = new Set<DocType>(['cash_register', 'store_operations', 'store_availability'])

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
  opts: { correlationId?: string; ip?: string; ua?: string } = {},
): Promise<StoreResult> {
  const meta = parseDocMeta(file.name)
  const buf = await file.arrayBuffer()
  const checksum = sha256(buf)
  const folder = meta.docDate ?? 'inbox'
  const dir = dateDir(orgId, folder)
  await mkdir(dir, { recursive: true })
  const canonicalPath = join(dir, file.name)

  const existing = await DocFile.findOne({ orgId, docType: meta.docType, docNumber: meta.docNumber })

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

export async function storeDocuments(orgId: string, userId: string, files: any[], opts: { correlationId?: string; ip?: string; ua?: string } = {}) {
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
    DocFile.find(q).sort({ docDate: -1, docType: 1, docNumber: 1 }).skip(page * size).limit(size).lean(),
    DocFile.countDocuments(q),
  ])
  return { docFiles: docs, total, page, size }
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
