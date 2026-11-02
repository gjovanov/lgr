import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { config } from 'config'
import { normalizeStored, resolveStored, validateStored } from 'services/biz/files/stored-path'
import type { Migration } from '../types.js'

/**
 * File paths relative to the upload root (FR-20.24, plan step P0b-8, release N+1), and the File
 * rows the Files app left behind (#180).
 *
 * Release N (#177) taught every reader both forms; this release's writers store the relative one,
 * and this rewrites the rows that are still absolute:
 *
 * 1. `DocFile.currentPath` and local `File.storagePath` go to the stored form
 *    (`<orgId>/docs/2026-08-27/invoicem_3000100827.pdf`). A path under no known upload root is
 *    left as it is and counted: a reader names it when it is opened.
 * 2. A local `File` row whose bytes are missing, but which a `DocFile` of the same org points at
 *    (`fileId`), is pointed at that document's path, and its `sha256` recorded. The Files app
 *    moved the document out of `docs/inbox/` without updating the row it was uploaded as (#180).
 *    A row whose recorded `sha256` differs from the document's bytes is NOT repointed: it
 *    describes other bytes. It is listed.
 * 3. A local `File` row with no bytes and no document to point it at (none, or one whose bytes
 *    are gone too) is LISTED, never deleted. They are re-uploads and deleted documents; removing
 *    them is the owner's call.
 * 4. `ArchiveUnit.path`, already relative, is given `/` separators (a Windows host wrote `\`).
 *
 * Idempotent: a second run finds every path in the stored form, every repointed row readable,
 * and the same rows without bytes, which it lists again and changes nothing. A rollback to the
 * previous release is safe (its readers take either form); one to a release before #177 is not.
 */
export const relativeFilePaths: Migration = {
  id: '0003-relative-file-paths',
  description: 'File paths stored relative to the upload root; File rows the Files app left in the inbox point at their document (FR-20.24, #180)',
  async up({ db, log, orgFilter }) {
    const docfiles = db.collection('docfiles')
    const files = db.collection('files')
    const localFiles = { ...orgFilter, storageProvider: { $in: ['local', null] } }

    // Steps 2 and 3 read the files. Where the upload volume is not mounted they would find no
    // bytes at all, repoint nothing and list every row, and the migration would still be recorded
    // as applied. Refused instead, so it runs again where the files are.
    const root = resolvePath(config.upload.dir)
    if (!(await isDirectory(root)) && (await files.countDocuments(localFiles, { limit: 1 }))) {
      throw new Error(`0003-relative-file-paths reads the uploaded files, and the upload root ${root} is not on this host: run it where the uploads volume is mounted`)
    }

    // 1. The stored form.
    const docPaths = await rewriteToStored(docfiles, 'currentPath', { ...orgFilter })
    const filePaths = await rewriteToStored(files, 'storagePath', localFiles)
    log(`DocFile.currentPath: ${describe(docPaths)}`)
    log(`File.storagePath: ${describe(filePaths)}`)

    // 2 and 3. Rows without bytes: repoint the ones a document of their own org claims, list the rest.
    const byFileId = new Map<string, { orgId: string; currentPath: string }>()
    for await (const d of docfiles.find({ ...orgFilter, fileId: { $exists: true } }, { projection: { orgId: 1, fileId: 1, currentPath: 1 } })) {
      if (d.fileId && typeof d.currentPath === 'string') byFileId.set(String(d.fileId), { orgId: String(d.orgId), currentPath: d.currentPath })
    }
    let repointed = 0
    const mismatched: string[] = []
    const orphans: string[] = []
    for await (const f of files.find(localFiles, { projection: { orgId: 1, storagePath: 1, sha256: 1 } })) {
      if (await readable(f.storagePath, f.orgId)) continue
      const claimed = byFileId.get(String(f._id))
      const doc = claimed && claimed.orgId === String(f.orgId) ? claimed : undefined
      const docBytes = doc && (await readable(doc.currentPath, f.orgId)) ? await hashFile(resolveStored(doc.currentPath, f.orgId)) : null
      if (!doc || !docBytes) { orphans.push(`${f._id} ${f.storagePath}`); continue }
      if (f.sha256 && f.sha256 !== docBytes) { mismatched.push(`${f._id} ${f.storagePath}`); continue }
      const res = await files.updateOne({ _id: f._id, storagePath: f.storagePath }, { $set: { storagePath: normalizeStored(doc.currentPath), sha256: docBytes } })
      repointed += res.modifiedCount
    }
    log(`File rows whose bytes are gone, repointed to the document that names them: ${repointed}`)
    log(`File rows whose bytes are gone and whose sha256 is not their document's (listed, not changed): ${listed(mismatched)}`)
    log(`File rows whose bytes are gone, with no document to point them at (listed, not deleted): ${listed(orphans)}`)

    // 4. Archive units: `/` separators.
    const archiveunits = db.collection('archiveunits')
    let archives = 0
    for await (const a of archiveunits.find({ ...orgFilter, path: { $regex: '\\\\' } }, { projection: { path: 1 } })) {
      const path = String(a.path).replace(/\\/g, '/')
      try { validateStored(path) } catch { continue }
      archives += (await archiveunits.updateOne({ _id: a._id, path: a.path }, { $set: { path } })).modifiedCount
    }
    if (archives) log(`ArchiveUnit.path: ${archives} given / separators`)
  },
}

/** Updates per `bulkWrite`. A master migrates before it listens, and a round-trip per row adds up. */
const BATCH = 500

interface Rewrite {
  converted: number
  unresolved: number
  /** Rows of one org naming a file in another org's tree. A reader refuses them in either form. */
  foreign: number
}

/** Rewrite `field` to the stored form wherever it is not already; count what could not be. */
async function rewriteToStored(coll: any, field: string, filter: Record<string, unknown>): Promise<Rewrite> {
  const out: Rewrite = { converted: 0, unresolved: 0, foreign: 0 }
  let ops: any[] = []
  const flush = async () => {
    if (!ops.length) return
    out.converted += (await coll.bulkWrite(ops, { ordered: false })).modifiedCount
    ops = []
  }
  for await (const row of coll.find({ ...filter, [field]: { $type: 'string', $ne: '' } }, { projection: { orgId: 1, [field]: 1 } })) {
    const value: string = row[field]
    let stored: string
    try { stored = normalizeStored(value) } catch { out.unresolved++; continue }
    if (stored.split('/')[0] !== String(row.orgId)) out.foreign++
    if (stored === value) continue
    // Guarded on the old value, so a writer that moved the row meanwhile wins.
    ops.push({ updateOne: { filter: { _id: row._id, [field]: value }, update: { $set: { [field]: stored } } } })
    if (ops.length >= BATCH) await flush()
  }
  await flush()
  return out
}

function describe(r: Rewrite): string {
  return `${r.converted} made relative; ${r.unresolved} under no known upload root, left as they are` +
    (r.foreign ? `; ${r.foreign} name another org's file, which no reader opens` : '')
}

/** A count, then the rows, one per line (the first 200). */
function listed(rows: string[]): string {
  if (!rows.length) return '0'
  const more = rows.length > 200 ? `\n  … and ${rows.length - 200} more` : ''
  return `${rows.length}\n  ${rows.slice(0, 200).join('\n  ')}${more}`
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

async function readable(stored: unknown, orgId: unknown): Promise<boolean> {
  if (typeof stored !== 'string' || !stored) return false
  try { return (await stat(resolveStored(stored, orgId))).isFile() } catch { return false }
}

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}
