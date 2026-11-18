import { createHash } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { DocFile, File, NodeState } from 'db/models'
import { logger } from '../../logger/logger.js'
import { normalizeStored, resolveStored, StoredPathError } from './stored-path.js'

/**
 * FR-32.11 (#797): deleting a file deletes its bytes.
 *
 * `DELETE /org/:orgId/file/:id` removed the row and left the stored file on disk, with nothing that would ever
 * find it again. `removeStoredFile` runs after the row is gone:
 * - Only `local` storage is a path this server can remove. Another provider's key is left alone and logged.
 * - Bytes another row still names stay: a `File` row of the same org, or a document of the Files app
 *   (`DocFile.currentPath`). Since #180 a `File` row follows its document's bytes, so the two can share a path.
 * - A file already gone is the state asked for.
 * - A removal that fails is logged and leaves a MARKER, a `NodeState` row (`file-removal:<hash>`). The marker is
 *   node state because the bytes are on this node's disk. The retention tick retries it
 *   (`retryPendingFileRemovals`) until the bytes are gone, or another row names them again.
 *
 * ⚠ Nothing here ever removes bytes a row still names, and nothing walks the upload folder: the only bytes it
 * removes are ones whose row a person has just deleted.
 */
export type RemovalOutcome = 'removed' | 'absent' | 'shared' | 'not_local' | 'outside' | 'pending'

const MARKER_PREFIX = 'file-removal:'
const markerId = (orgId: string, stored: string) =>
  MARKER_PREFIX + createHash('sha256').update(`${orgId}\n${stored}`).digest('hex').slice(0, 48)

interface StoredFile {
  orgId: unknown
  storagePath?: string | null
  storageProvider?: string | null
}

/** The forms a row may hold the same bytes under: the relative path, and the absolute one written before #177. */
function namesOf(stored: string, orgId: string): string[] {
  const names = new Set<string>([stored])
  try { names.add(normalizeStored(stored)) } catch { /* not a path of ours: matched only as written */ }
  try { names.add(resolveStored(stored, orgId)) } catch { /* not under a known root: matched only as written */ }
  return [...names]
}

async function stillNamed(orgId: string, stored: string): Promise<boolean> {
  const names = namesOf(stored, orgId)
  const [file, doc] = await Promise.all([
    File.exists({ orgId, storagePath: { $in: names } }),
    DocFile.exists({ orgId, currentPath: { $in: names } }),
  ])
  return !!file || !!doc
}

/** Remove the bytes once; the error, if any, is the caller's to record. */
async function removeOnce(orgId: string, stored: string): Promise<Exclude<RemovalOutcome, 'pending' | 'not_local'>> {
  if (await stillNamed(orgId, stored)) return 'shared'
  let absolute: string
  try {
    absolute = resolveStored(stored, orgId)
  } catch (e) {
    // A path outside this org's tree, or under no root this server knows: never removed from here.
    if (e instanceof StoredPathError) return 'outside'
    throw e
  }
  try {
    await rm(absolute)
    return 'removed'
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
    throw e
  }
}

export async function removeStoredFile(file: StoredFile): Promise<RemovalOutcome> {
  const orgId = String(file.orgId)
  const stored = file.storagePath ?? ''
  if (!stored) return 'absent'
  if (file.storageProvider && file.storageProvider !== 'local') {
    logger.warn({ orgId, storageProvider: file.storageProvider }, 'file deleted: its bytes are with another provider and stay there')
    return 'not_local'
  }
  try {
    const done = await removeOnce(orgId, stored)
    if (done === 'outside') logger.warn({ orgId, storagePath: stored }, 'file deleted: its stored path is not one this server removes')
    return done
  } catch (err) {
    logger.warn({ err, orgId, storagePath: stored }, 'file deleted: its bytes could not be removed; the retention tick retries')
    try {
      await NodeState.updateOne(
        { _id: markerId(orgId, stored) },
        {
          $set: { 'value.kind': 'file-removal', 'value.orgId': orgId, 'value.storagePath': stored, 'value.lastError': String((err as Error)?.message ?? err).slice(0, 300) },
          $inc: { 'value.attempts': 1 },
          $setOnInsert: { 'value.since': new Date() },
        },
        { upsert: true },
      ).exec()
    } catch (markErr) {
      // The row is deleted either way: what is lost is only the retry, and the log says which bytes stayed.
      logger.error({ err: markErr, orgId, storagePath: stored }, 'file deleted: its bytes stayed, and the retry marker could not be written')
    }
    return 'pending'
  }
}

export interface RetryOutcome {
  removed: number
  stillPending: number
}

/** One retention pass over the markers: each is removed, cleared as shared or absent, or tried again next time. */
export async function retryPendingFileRemovals(limit: number): Promise<RetryOutcome> {
  const out: RetryOutcome = { removed: 0, stillPending: 0 }
  const markers = await NodeState.find({ _id: { $regex: `^${MARKER_PREFIX}` } }).limit(limit).lean().exec()
  for (const m of markers) {
    const v = (m.value ?? {}) as { orgId?: string; storagePath?: string }
    if (!v.orgId || !v.storagePath) {
      await NodeState.deleteOne({ _id: m._id }).exec()
      continue
    }
    try {
      const done = await removeOnce(v.orgId, v.storagePath)
      if (done === 'removed') out.removed++
      await NodeState.deleteOne({ _id: m._id }).exec()
    } catch (err) {
      out.stillPending++
      logger.warn({ err, orgId: v.orgId, storagePath: v.storagePath }, 'a deleted file\'s bytes still could not be removed')
      await NodeState.updateOne(
        { _id: m._id },
        { $set: { 'value.lastError': String((err as Error)?.message ?? err).slice(0, 300) }, $inc: { 'value.attempts': 1 } },
      ).exec()
    }
  }
  return out
}
