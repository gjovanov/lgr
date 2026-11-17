import type { Migration } from '../types.js'
import { searchFieldUpdate, staleSearchField, type SearchFieldConfig } from 'db/plugins/search-field'

/**
 * FR-30.11: every article carries `searchLower`, the five lowered mirrors joined, which the product search reads through
 * `{ orgId, searchLower, isActive, _id }`.
 *
 * The lowered-fields plugin keeps the field on every write from this release on; this fills it on the articles written
 * before. Until it has run an org's search still finds every article (one without the field is read by its mirrors,
 * `services/biz/product-search-field.ts`), only slower. A migration, not only `scripts/backfill-product-search-field.ts`,
 * because a master has no operator to run a script.
 *
 * The database computes the value from the stored mirrors, and writes only an article whose field is missing or stale:
 * a second run changes nothing. Scoped by `orgFilter`.
 *
 * Rollback: the previous release neither reads nor writes the field; it stays, harmless.
 */
export const PRODUCT_SEARCH_FIELD: SearchFieldConfig = {
  field: 'searchLower',
  parts: ['nameLower', 'skuLower', 'barcodeLower', 'descriptionLower', 'categoryLower'],
}

export const productSearchField: Migration = {
  id: '0018-product-search-field',
  description: 'Fill Product.searchLower, the joined search field, on the articles written before it (FR-30.11)',
  async up({ db, log, orgFilter }) {
    const res = await db.collection('products').updateMany(staleSearchField(PRODUCT_SEARCH_FIELD, orgFilter), searchFieldUpdate(PRODUCT_SEARCH_FIELD))
    log(`products: the search field set on ${res.modifiedCount} article(s)`)
  },
}
