/**
 * FR-25a §3.5: the contact search finds a contact by its МОЛ through a lowered mirror, `representativeLower`, which the
 * model's plugin (`loweredFieldsPlugin`) keeps from the release that added it, on every write the routes and the
 * importers make (a create, an insertMany, a `$set`). ⚠ Not on an update that names the field at its top level beside
 * the `$set` the schema's timestamps add: the plugin then reads only the `$set`. A МОЛ written before
 * that (the importers since #746, the contact form since #748) has no mirror, so the search does not find it: this
 * writes the mirror the plugin would have written, and drops a mirror whose МОЛ is gone.
 *
 * Only the mirror is written, never the МОЛ, and `updatedAt` is left alone: nothing about the contact changed. Each
 * write is conditional on what the plan read, so a contact saved in between keeps what the plugin wrote for it.
 * Idempotent: a second run finds nothing to write.
 */
import { mongoose } from '../../packages/db/src/connection.js'
import { Contact } from '../../packages/db/src/models/index.js'

export interface MirrorRow {
  _id: unknown
  representative?: unknown
  representativeLower?: unknown
}

export interface MirrorPlan {
  ops: any[]
  counts: { scanned: number; set: number; unset: number }
}

/** What the plugin writes for a МОЛ: the string lowered in the `bg` locale; nothing for a contact without one. */
export function mirrorOf(representative: unknown): string | undefined {
  return typeof representative === 'string' ? representative.toLocaleLowerCase('bg') : undefined
}

export function planRepresentativeMirror(rows: readonly MirrorRow[]): MirrorPlan {
  const counts = { scanned: rows.length, set: 0, unset: 0 }
  const ops: any[] = []
  for (const row of rows) {
    const want = mirrorOf(row.representative)
    const has = typeof row.representativeLower === 'string' ? row.representativeLower : undefined
    if (want === has) continue
    // `null` matches a field that is absent as well as one that is null.
    const filter = { _id: row._id, representative: row.representative ?? null, representativeLower: row.representativeLower ?? null }
    if (want === undefined) {
      counts.unset++
      ops.push({ updateOne: { filter, update: { $unset: { representativeLower: 1 } }, timestamps: false } })
    } else {
      counts.set++
      ops.push({ updateOne: { filter, update: { $set: { representativeLower: want } }, timestamps: false } })
    }
  }
  return { ops, counts }
}

/** The org's contacts that have a МОЛ or a mirror, with what the plan reads. */
export async function contactsWithRepresentative(orgId: unknown): Promise<MirrorRow[]> {
  return Contact.find(
    { orgId: new mongoose.Types.ObjectId(String(orgId)), $or: [{ representative: { $exists: true } }, { representativeLower: { $exists: true } }] },
    { representative: 1, representativeLower: 1 },
  ).lean() as any
}

/** Writes in batches; answers how many contacts changed. */
export async function applyMirrorWrites(ops: readonly any[]): Promise<number> {
  let modified = 0
  for (let i = 0; i < ops.length; i += 500) {
    const r = await Contact.bulkWrite(ops.slice(i, i + 500) as any[], { ordered: false })
    modified += r.modifiedCount
  }
  return modified
}
