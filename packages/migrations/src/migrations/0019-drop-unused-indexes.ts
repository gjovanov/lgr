import type { Migration } from '../types.js'

/**
 * FR-30.5: the indexes production does not use are dropped.
 *
 * ⚠ DRAFT, not before 2026-11-23: the list below is filled from `scripts/index-usage.ts` read on production's primary a
 * week after FR-30.1 to .4 were deployed (counters and sizes only). Each entry is an index with no use since that
 * member started; an unused index that is kept is written in `KEPT` with its reason. The schemas lose the same
 * declarations in this pull request, or the next start builds them back.
 *
 * Drops by name and skips what is not there. Idempotent. Collection-wide, like any index: `orgFilter` does not apply.
 *
 * Rollback: the previous release declares the indexes again, and its first start builds them back.
 */
export const UNUSED_INDEXES: Record<string, string[]> = {
  // 'invoices': ['<name>'],   ← from the production reading
}

/** Unused on production, and kept: the reason beside each. */
export const KEPT: Record<string, string> = {
  // '<collection>.<name>': '<why>',
}

export const dropUnusedIndexes: Migration = {
  id: '0019-drop-unused-indexes',
  description: 'Drop the indexes production does not use (FR-30.5)',
  async up({ db, log }) {
    const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
    for (const [collection, names] of Object.entries(UNUSED_INDEXES)) {
      if (!present.has(collection)) continue
      const have = new Set((await db.collection(collection).indexes()).map((i) => i.name))
      for (const name of names) {
        if (!have.has(name)) continue
        await db.collection(collection).dropIndex(name)
        log(`${collection}: the unused index ${name} dropped`)
      }
    }
  },
}
