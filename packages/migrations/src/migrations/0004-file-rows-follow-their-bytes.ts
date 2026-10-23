import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { extname, join, resolve as resolvePath } from 'node:path'
import { config } from 'config'
import { normalizeStored, resolveStored, toStored } from 'services/biz/files/stored-path'
import { safeFileName } from 'services/biz/files/safe-path'
import type { Migration } from '../types.js'

/**
 * File rows that name where their bytes USED to be (#180, the rows 0003 listed).
 *
 * Until #182 the Files app moved a document's bytes in two places without moving its File row:
 *   - a re-upload archived the previous version to `docs/<date>/versions/<base>_<stamp><ext>`;
 *   - a delete moved the document to `docs/_deleted/<date>/<base>_<stamp><ext>`.
 * The row was left naming the old path, which then held nothing, or held the NEXT version: a
 * re-upload writes the new bytes to the same canonical path, so the old row still opens a file,
 * just not its own. Production on 2026-10-23: 91 rows of the first kind, 25 of the second.
 *
 * Each such row is pointed at the one file in its own org's `versions/` and `_deleted/` folders
 * that carries its name and its size, and that file's sha256 is recorded.
 *   - Two or more candidates: LISTED, not guessed at.
 *   - None: listed. The bytes are gone, and removing the row is an operator's decision.
 *   - Never another org's folder, never a file another row already names, and never a row a
 *     DocFile claims: a document's own row follows the document (0003, and #182's writers).
 *
 * Idempotent: once repointed, a row opens a file of its own size and is not touched again.
 */
export const fileRowsFollowTheirBytes: Migration = {
  id: '0004-file-rows-follow-their-bytes',
  description: 'File rows left naming a path a re-upload or a delete moved their bytes from point at those bytes again (#180)',
  async up({ db, log, orgFilter }) {
    const files = db.collection('files')
    const localFiles = { ...orgFilter, storageProvider: { $in: ['local', null] } }
    const root = resolvePath(config.upload.dir)
    if (!(await isDirectory(root)) && (await files.countDocuments(localFiles, { limit: 1 }))) {
      throw new Error(`0004-file-rows-follow-their-bytes reads the uploaded files, and the upload root ${root} is not on this host: run it where the uploads volume is mounted`)
    }

    const claimed = new Set<string>()
    for await (const d of db.collection('docfiles').find({ ...orgFilter, fileId: { $exists: true } }, { projection: { fileId: 1 } })) {
      if (d.fileId) claimed.add(String(d.fileId))
    }
    // Every path a row names: a file one row already names is nobody else's to take.
    const named = new Set<string>()
    for await (const f of files.find(localFiles, { projection: { storagePath: 1 } })) {
      const stored = storedOrNull(f.storagePath)
      if (stored) named.add(stored)
    }

    const archives = new Map<string, Archived[]>() // org → its versions/ and _deleted/ files
    let repointed = 0
    const ambiguous: string[] = []
    const gone: string[] = []
    for await (const f of files.find(localFiles, { projection: { orgId: 1, storagePath: 1, originalName: 1, size: 1 } })) {
      if (claimed.has(String(f._id)) || typeof f.size !== 'number') continue
      const org = String(f.orgId)
      const here = await sizeAt(f.storagePath, org)
      if (here === f.size) continue // its own bytes, or at least bytes of its size: leave it

      if (!archives.has(org)) archives.set(org, await archivedFiles(root, org))
      const name = nameOf(f)
      if (!name) { gone.push(`${f._id} ${f.storagePath}`); continue }
      const ext = extname(name)
      const pattern = new RegExp(`^${escape(name.slice(0, name.length - ext.length))}_\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z${escape(ext)}$`)
      const candidates = archives.get(org)!.filter(a => pattern.test(a.name) && a.size === f.size && !named.has(a.stored))
      if (candidates.length > 1) { ambiguous.push(`${f._id} ${f.storagePath} (${candidates.length} candidates)`); continue }
      if (!candidates.length) { gone.push(`${f._id} ${f.storagePath}`); continue }

      const [found] = candidates
      const sha256 = await hashFile(found.path)
      // Guarded on the old value, so a writer that moved the row meanwhile wins.
      const res = await files.updateOne({ _id: f._id, storagePath: f.storagePath }, { $set: { storagePath: found.stored, sha256 } })
      if (res.modifiedCount) { repointed++; named.add(found.stored) }
    }
    log(`File rows pointed back at their own bytes in versions/ or _deleted/: ${repointed}`)
    log(`File rows with more than one candidate (listed, not changed): ${listed(ambiguous)}`)
    log(`File rows whose bytes are nowhere (listed, not deleted): ${listed(gone)}`)
  },
}

interface Archived {
  /** The file's name in its folder. */
  name: string
  /** Its absolute path on this host. */
  path: string
  /** Its stored form, relative to the upload root. */
  stored: string
  size: number
}

/** An org's `docs/<date>/versions/*` and `docs/_deleted/<date>/*` files. */
async function archivedFiles(root: string, orgId: string): Promise<Archived[]> {
  const docs = join(root, orgId, 'docs')
  const out: Archived[] = []
  const add = async (dir: string) => {
    for (const name of await list(dir)) {
      const path = join(dir, name)
      try {
        const s = await stat(path)
        if (s.isFile()) out.push({ name, path, stored: toStored(path), size: s.size })
      } catch { /* gone meanwhile */ }
    }
  }
  for (const day of await list(docs)) {
    if (day === '_deleted') {
      for (const deletedDay of await list(join(docs, '_deleted'))) await add(join(docs, '_deleted', deletedDay))
    } else {
      await add(join(docs, day, 'versions'))
    }
  }
  return out
}

/** The name the Files app stored the document under. */
function nameOf(f: { originalName?: unknown; storagePath?: unknown }): string | null {
  try {
    if (typeof f.originalName === 'string' && f.originalName) return safeFileName(f.originalName)
    const stored = String(f.storagePath ?? '')
    return safeFileName(stored.split(/[\\/]/).pop())
  } catch {
    return null
  }
}

function storedOrNull(p: unknown): string | null {
  try { return typeof p === 'string' && p ? normalizeStored(p) : null } catch { return null }
}

async function sizeAt(stored: unknown, orgId: string): Promise<number | null> {
  if (typeof stored !== 'string' || !stored) return null
  try {
    const s = await stat(resolveStored(stored, orgId))
    return s.isFile() ? s.size : null
  } catch {
    return null
  }
}

async function list(dir: string): Promise<string[]> {
  try { return await readdir(dir) } catch { return [] }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory() } catch { return false }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function listed(rows: string[]): string {
  if (!rows.length) return '0'
  const more = rows.length > 200 ? `\n  … and ${rows.length - 200} more` : ''
  return `${rows.length}\n  ${rows.slice(0, 200).join('\n  ')}${more}`
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
