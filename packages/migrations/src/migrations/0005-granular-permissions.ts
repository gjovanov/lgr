import type { Migration } from '../types.js'

/**
 * The legacy `trade.*` permissions, rewritten into the granular ones they stood for.
 *
 * `trade.read`, `trade.write`, `trade.adjust` and `trade.send` predate the split of trade into
 * inventory, invoicing and point of sale. Until this release every auth plugin expanded them on
 * each request (`LEGACY_PERMISSION_MAP`, now gone). On 2026-10-23 they still sat in 452 of
 * production's 686 permission sets and in 88 users' own permission lists, most of them seeded by
 * older releases.
 *
 * Each one is replaced by exactly what it expanded to, so nobody's effective rights change: a set
 * that granted `trade.write` now says inventory.write, invoicing.write and pos.write, where an
 * admin can see them. Narrowing a set to its role is the org admin's decision, in the UI.
 *
 * Scope: `permissionsets.permissions`, `users.permissions`, `invites.permissions`. Every other
 * entry keeps its place; the expansions follow, without duplicates. Idempotent: a second run finds
 * nothing to rewrite.
 */
export const granularPermissions: Migration = {
  id: '0005-granular-permissions',
  description: 'Legacy trade.* permissions rewritten into the inventory/invoicing/pos permissions they expanded to',
  async up({ db, log, orgFilter }) {
    const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name))
    for (const name of ['permissionsets', 'users', 'invites']) {
      if (!present.has(name)) continue
      const coll = db.collection(name)
      let rewritten = 0
      let ops: any[] = []
      const flush = async () => {
        if (!ops.length) return
        rewritten += (await coll.bulkWrite(ops, { ordered: false })).modifiedCount
        ops = []
      }
      for await (const doc of coll.find({ ...orgFilter, permissions: { $in: Object.keys(EXPANDS) } }, { projection: { permissions: 1 } })) {
        const before: unknown[] = Array.isArray(doc.permissions) ? doc.permissions : []
        const after = granular(before)
        // Guarded on the old list, so a write that changed it meanwhile wins.
        ops.push({ updateOne: { filter: { _id: doc._id, permissions: before }, update: { $set: { permissions: after } } } })
        if (ops.length >= 500) await flush()
      }
      await flush()
      log(`${name}: ${rewritten} rewritten without trade.*`)
    }
  },
}

/**
 * What each legacy grant expanded to, frozen here: the constant the auth plugins used is deleted
 * in the same release, and a migration must keep meaning what it meant when it was written.
 */
const EXPANDS: Readonly<Record<string, readonly string[]>> = {
  'trade.read': ['inventory.read', 'invoicing.read', 'pos.read'],
  'trade.write': ['inventory.write', 'invoicing.write', 'pos.write'],
  'trade.adjust': ['inventory.adjust'],
  'trade.send': ['invoicing.send'],
}

/** The list without `trade.*`, the expansions appended in order, each permission once. */
export function granular(permissions: readonly unknown[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (p: string) => { if (!seen.has(p)) { seen.add(p); out.push(p) } }
  for (const p of permissions) if (typeof p === 'string' && !(p in EXPANDS)) add(p)
  for (const p of permissions) if (typeof p === 'string' && p in EXPANDS) EXPANDS[p].forEach(add)
  return out
}
