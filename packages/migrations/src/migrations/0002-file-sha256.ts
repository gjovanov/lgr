import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { resolveStored } from 'services/biz/files/stored-path'
import type { Migration } from '../types.js'

/**
 * `File.sha256` for every file uploaded before it was recorded (FR-20.24, plan step P0b-8).
 *
 * The checksum is what a file copied to another server (a restore, an org moving to a master) is
 * checked against; new uploads record it as they are written. This hashes the bytes on disk of
 * every local `File` row that has none.
 *
 * - A row whose bytes are missing, or whose path resolves nowhere, is left without one and counted:
 *   inventing a checksum would certify a file nobody has. A later run tries it again.
 * - Expand only: a field the previous release ignores.
 */
export const fileSha256: Migration = {
  id: '0002-file-sha256',
  description: 'Record File.sha256 for files uploaded before it was kept (FR-20.24)',
  async up({ db, log, orgFilter }) {
    const files = db.collection('files')
    let hashed = 0
    let missing = 0
    const cursor = files.find(
      { ...orgFilter, sha256: { $exists: false }, storageProvider: { $in: ['local', null] } },
      { projection: { orgId: 1, storagePath: 1 } },
    )
    for await (const f of cursor) {
      let sha256: string
      try {
        sha256 = await hashFile(resolveStored(String(f.storagePath), f.orgId))
      } catch {
        missing++
        continue
      }
      await files.updateOne({ _id: f._id, sha256: { $exists: false } }, { $set: { sha256 } })
      hashed++
    }
    log(`File.sha256 recorded for ${hashed} file(s); ${missing} without readable bytes left as they are`)
  },
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
