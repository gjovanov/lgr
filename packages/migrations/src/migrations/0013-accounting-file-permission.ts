import type { Migration } from '../types.js'

/**
 * FR-25 R2: `accounting.file` is new, and generating a VAT return's files and recording that a person
 * filed them needs it. A stored permission set, or a user's or an invite's own list, was written
 * before it existed, so nobody would hold it: the accountant's first press of Generate would be a 403.
 *
 * It goes to whoever can already post to the ledger (`accounting.post`). A set with that decided an
 * accountant's work in full, and a read-only set has no business filing. An admin set is expanded to
 * every permission when a token is issued, and gains it here all the same, so that the list stays
 * what it says.
 *
 * ⚠ A JWT carries what it was issued with: people need to sign in again after this has run (FR-6.2).
 *
 * Expand and contract both hold: the previous release ignores a permission it does not know.
 * Idempotent: `$addToSet`, and the filter leaves out whoever has it.
 */
const GRANTED = 'accounting.file'
const HELD_BY = 'accounting.post'
const COLLECTIONS = ['permissionsets', 'users', 'invites']

export const accountingFilePermission: Migration = {
  id: '0013-accounting-file-permission',
  description: 'Whoever holds accounting.post gains accounting.file, the permission to generate and mark filed a VAT return (FR-25 R2)',
  async preview({ db, orgFilter }) {
    const lines: string[] = []
    for (const name of COLLECTIONS) {
      const n = await db.collection(name).countDocuments({ ...orgFilter, permissions: { $eq: HELD_BY, $ne: GRANTED } })
      if (n) lines.push(`${name}: ${n} gain ${GRANTED}`)
    }
    return lines.length ? lines : ['nothing to change']
  },
  async up({ db, log, orgFilter }) {
    const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
    for (const name of COLLECTIONS) {
      if (!present.has(name)) continue
      const r = await db.collection(name).updateMany(
        { ...orgFilter, permissions: { $eq: HELD_BY, $ne: GRANTED } },
        { $addToSet: { permissions: GRANTED } },
      )
      log(`${name}: ${r.modifiedCount} gained ${GRANTED}`)
    }
  },
}
