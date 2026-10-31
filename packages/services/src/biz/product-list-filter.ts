import type { Filter, IBatchRepository, IProduct } from 'dal'
import { buildProductSearchFilter } from './search.utils.js'

/**
 * The Products list's filters — its search (`buildProductSearchFilter`: name, SKU, barcode, …,
 * Latin/Cyrillic look-alikes as one letter), category, type, tags and status — as one product
 * query. The Movements list finds its documents by the same filters, applied to the articles
 * their lines carry, so a search finds the same articles on both pages.
 *
 * Which warehouse holds them is not here: on the Products list that is a stock question, and a
 * movement names its warehouses itself.
 */
export interface ProductListQuery {
  search?: string
  category?: string
  type?: string
  /** Any of these tags: a CSV string, or the repeated query parameter's array. */
  tags?: string | string[]
  /** FR-22.48: 'true' = active, 'false' = deactivated, anything else = both. */
  isActive?: string
}

export function buildProductListFilter(orgId: string, q: ProductListQuery): Record<string, any> {
  const filter: Record<string, any> = { orgId }
  if (q.category) filter.category = q.category
  if (q.type) filter.type = q.type
  if (q.search) Object.assign(filter, buildProductSearchFilter(q.search))
  if (q.tags) {
    const tagList = Array.isArray(q.tags) ? q.tags : q.tags.split(',')
    filter.tags = { $in: tagList }
  }
  // "Active" is `$ne: false`, not `true`: a product saved before the field existed has none, and
  // has always been listed as active.
  if (q.isActive === 'true') filter.isActive = { $ne: false }
  else if (q.isActive === 'false') filter.isActive = false
  return filter
}

/** True when the query narrows the articles at all (the org alone does not). */
export function hasProductListFilter(q: ProductListQuery): boolean {
  return !!(q.search || q.category || q.type || q.tags?.length || q.isActive === 'true' || q.isActive === 'false')
}

/** The ids of every article the filter finds; ids only, since an org holds tens of thousands. */
export async function productIdsMatching(products: IBatchRepository<IProduct>, filter: Record<string, any>): Promise<string[]> {
  const rows = await products.aggregate<{ _id: unknown }>([{ $match: filter as Filter<IProduct> }, { $project: { _id: 1 } }] as any)
  return rows.map((r) => String(r._id))
}
