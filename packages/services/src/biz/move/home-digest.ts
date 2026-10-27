/**
 * Digests of an org's documents as its HOME holds them, whatever the order of their fields (FR-20.80,
 * plan step P3-6c): what a move back compares between the master and global's mirror.
 *
 * - **Home parts only** (`homePart`), which is what pages carry. Global's own parts of a split
 *   document (its billing, `settings.node`, a membership's person fields) and a node's are never
 *   compared: they are not the home's, and they differ by design.
 * - ⚠ **Order-insensitive.** The mirror writes a split document with `$replaceWith: {$mergeObjects:
 *   [home, kept]}`, which orders its fields differently from how the home stored them. A digest over
 *   stored order (`collectionDigests`, the forward move's) would call every split document different.
 *   Object keys are sorted at every level; arrays keep their order, which is data.
 * - **Type-exact.** Read with `promoteValues: false` and written as canonical EJSON, so an Int32
 *   never equals a Double, nor a Long a number.
 */
import type { mongo } from 'mongoose'
import { createHash } from 'node:crypto'
import { mongoose } from 'db/connection'
import { homePart, isPlain } from '../replication/project.js'
import { moveCollections, type Digests } from './move-bundle.js'

type Db = mongo.Db
type ObjectId = mongo.ObjectId

const EJSON = mongoose.mongo.BSON.EJSON

/** `v` with every plain object's keys sorted, at every level. BSON values are leaves. */
export function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (isPlain(v)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v).sort()) out[k] = canonical((v as Record<string, unknown>)[k])
    return out
  }
  return v
}

/** One document as the digest reads it: its home parts, canonical. */
export function homeLine(entry: Parameters<typeof homePart>[1], doc: Record<string, unknown>): string {
  return `${EJSON.stringify(canonical(homePart(doc, entry)) as any, { relaxed: false })}\n`
}

/** Per collection, the count and sha256 of the org's documents as its home holds them. */
export async function homeDigests(db: Db, orgId: ObjectId): Promise<Digests> {
  const out: Digests = {}
  for (const e of moveCollections()) {
    const h = createHash('sha256')
    let count = 0
    const filter = e.orgPath === '_id' ? { _id: orgId } : { orgId }
    for await (const doc of db.collection(e.collection).find(filter as any, { sort: { _id: 1 }, promoteValues: false })) {
      h.update(homeLine(e, doc as Record<string, unknown>))
      count++
    }
    if (count) out[e.collection] = { count, sha256: h.digest('hex') }
  }
  return out
}
