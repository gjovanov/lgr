import { getRepos } from '../context.js'
import { buildProductSearchFilter } from './search.utils.js'

/**
 * The article a typed or scanned code names (FR-22.55, moved here by FR-33.11, #933). One rule for the till's and the
 * cash-sale terminal's `GET /trade/pos/catalog/lookup` and for `GET /warehouse/product/lookup`, which the stock count
 * asks: a count role reads it without any till rights.
 */

/** The terminals' grid filter: active products, the typed search, and the category / type / tag filters. */
export function catalogFilter(orgId: string, query: Record<string, any>): Record<string, any> {
  const productFilter: Record<string, any> = { orgId, isActive: true }
  if (query.search) {
    // The same search the inventory product list runs (see buildProductSearchFilter).
    Object.assign(productFilter, buildProductSearchFilter(query.search as string))
  }
  if (query.category) productFilter.category = query.category
  if (query.type) productFilter.type = query.type
  if (query.tags) {
    const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
    productFilter.tags = { $in: tagList }
  }
  return productFilter
}

export type CodeMatch = 'barcode' | 'sku' | 'search'

/**
 * FR-22.55: the product Enter adds from a search. A barcode scanner types the code and presses Enter within
 * milliseconds, long before the search's 300 ms debounce has filtered anything, so the screen asks here instead of
 * counting the rows it shows.
 *
 * The first rung that matches anything decides:
 *   1. the barcode is the code: as typed, then ignoring case;
 *   2. the SKU is the code, the same way (a barcode outranks a SKU: a scanner reads barcodes);
 *   3. no exact match: the grid's own search, with the grid's filters, finds exactly one product.
 * Two products on the deciding rung answer `null`, as does a search finding several: a scan is
 * never guessed, and the screen shows the search instead. Only active products, as in the
 * grid. The exact rungs ignore the grid's category / type / tag filters: a scanned article is
 * that article, whatever the cashier was browsing.
 */
export async function lookupProductCode(
  orgId: string,
  code: string,
  query: Record<string, any> = {},
): Promise<{ product: any; matchedBy: CodeMatch } | null> {
  const r = getRepos()
  const lower = code.toLocaleLowerCase('bg')
  // The raw fields as well as the `*Lower` mirrors: a product written past the mirror hooks
  // (a bulkWrite) is still found by the code exactly as printed on it.
  const exact = await r.products.findAll({
    orgId,
    isActive: true,
    $or: [{ barcode: code }, { barcodeLower: lower }, { sku: code }, { skuLower: lower }],
  }, { page: 0, size: 20, sort: { name: 1 } })
  const folded = (v: unknown) => (typeof v === 'string' ? v.toLocaleLowerCase('bg') : undefined)
  const rungs: Array<[CodeMatch, (p: any) => boolean]> = [
    ['barcode', p => p.barcode === code],
    ['barcode', p => folded(p.barcode) === lower],
    ['sku', p => p.sku === code],
    ['sku', p => folded(p.sku) === lower],
  ]
  for (const [matchedBy, matches] of rungs) {
    const hits = exact.items.filter(matches)
    if (hits.length === 1) return { product: hits[0], matchedBy }
    if (hits.length > 1) return null
  }
  const found = await r.products.findAll(catalogFilter(orgId, { ...query, search: code }), { page: 0, size: 2, sort: { name: 1 } })
  return found.total === 1 ? { product: found.items[0], matchedBy: 'search' } : null
}
