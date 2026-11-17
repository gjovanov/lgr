import type { Migration } from '../types.js'

/**
 * FR-30.4: the seven text indexes nothing reads are dropped.
 *
 * `Account`, `Contact`, `Employee`, `Invoice`, `ProductCategory`, `Product` and `StockMovement` each declared one.
 * No query of the server ran `$text` (the one that did was a DAO method nothing called), every search is a pattern
 * over the fields or their lowered mirrors, and every write kept the index up: on a shop-year of data an invoice
 * carried 22 indexes and a product 14. The schemas no longer declare them, but a server only BUILDS what a schema
 * declares (Mongoose's autoIndex); it never drops what a schema stopped declaring, so every existing database keeps
 * them until this runs.
 *
 * A collection holds at most one text index, whatever its name: an index whose key has `_fts: 'text'`. It is dropped
 * by the name the database gives it, and a collection without one (or not there at all) is skipped. Idempotent.
 * Collection-wide, like any index: `orgFilter` does not apply.
 *
 * Rollback: the previous release declares the indexes again, so its first start builds them back. Nothing else reads
 * them.
 */
export const TEXT_INDEX_COLLECTIONS = ['accounts', 'contacts', 'employees', 'invoices', 'productcategories', 'products', 'stockmovements'] as const

export const dropUnreadTextIndexes: Migration = {
  id: '0016-drop-unread-text-indexes',
  description: 'Drop the seven text indexes nothing reads; every write kept them up (FR-30.4)',
  async up({ db, log }) {
    const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c: { name: string }) => c.name))
    for (const name of TEXT_INDEX_COLLECTIONS) {
      if (!present.has(name)) continue
      const collection = db.collection(name)
      for (const index of await collection.indexes()) {
        if ((index.key as Record<string, unknown>)?._fts !== 'text' || !index.name) continue
        await collection.dropIndex(index.name)
        log(`${name}: the text index ${index.name} dropped`)
      }
    }
  },
}
