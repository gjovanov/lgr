import type { Filter, IProduct } from 'dal'
import { getRepos } from '../context.js'
import type { AccessCaller } from './access/evaluate.js'
import { buildProductListFilter } from './product-list-filter.js'
import { hasStockFilter, parseStockFilter, productIdsPassingStockFilter, type StockFilter } from './product-stock-filter.js'
import { canSeeSupplierFacts, findProductIdsBySuppliers, findProductIdsWithoutSupplier } from './product-suppliers.service.js'

/**
 * The Products list's query — the parameters of `GET /warehouse/product` — resolved to ONE product filter.
 *
 * FR-28.14 / .16: "all that match the filter" travels to the server as the filter, never as a list of ids, and
 * the server resolves it with the list's OWN builder. This is that builder, taken out of the controller so the
 * list and the order preview cannot drift: the search (`buildProductListFilter`), the warehouse restriction, the
 * `ids` override, and the supplier and quantity filters (FR-28.3), all AND-ed, in the order the list applies them.
 *
 * The values are what a querystring or a JSON body carries: strings (a tag list may also be an array).
 */
export type ProductListQuery = Record<string, unknown>

/** A refused filter: who we buy from is part of the incoming documents, which the caller's role does not read. */
export interface ProductListRefusal {
  statusCode: 403
  body: { code: 'capability_required'; capabilities: ['bills.view']; message: string }
}

export const SUPPLIER_FILTER_REFUSAL: ProductListRefusal = {
  statusCode: 403,
  body: {
    code: 'capability_required',
    capabilities: ['bills.view'],
    message: 'Who we buy from is part of the incoming documents, which are not part of your role.',
  },
}

export type ResolvedProductListFilter =
  | { refusal: ProductListRefusal }
  | { refusal?: undefined; filter: Filter<IProduct> & Record<string, any>; stock: StockFilter }

/** The id list a querystring carries: what is not an ObjectId matches nothing. */
const idList = (v: unknown): string[] => String(v ?? '').split(',').filter((id) => /^[0-9a-f]{24}$/i.test(id))

export async function resolveProductListFilter(
  orgId: string,
  query: ProductListQuery,
  user: AccessCaller | null | undefined,
): Promise<ResolvedProductListFilter> {
  const r = getRepos()

  // FR-22.48: the Products list asks for active or deactivated articles; without the param every caller (the
  // pickers, the API clients) still gets both. The Movements list filters by the same rules.
  const filter = buildProductListFilter(orgId, {
    search: query.search as string | undefined,
    category: query.category as string | undefined,
    type: query.type as string | undefined,
    tags: query.tags as string | string[] | undefined,
    isActive: query.isActive as string | undefined,
  })

  // FR-28.3: filter by supplier and by quantity. Who we buy from is incoming-document data, so a caller who may
  // not read bills is refused rather than answered with a list that hides why.
  const supplierIds = String(query.supplierId ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  const noSupplier = query.noSupplier === 'true' || query.noSupplier === '1' || query.noSupplier === true
  if ((supplierIds.length || noSupplier) && !canSeeSupplierFacts(user)) return { refusal: SUPPLIER_FILTER_REFUSAL }
  const stock = parseStockFilter(query)
  const byStock = hasStockFilter(stock)

  // With a warehouse chosen the list shows only what is held there. A quantity filter decides instead
  // (FR-28.3): "below minimum in warehouse X" is exactly the articles X has none of.
  if (query.warehouseId && !byStock) {
    // Restrict to products that currently hold stock in the selected warehouse.
    const stockHere = await r.stockLevels.findMany({ orgId, warehouseId: query.warehouseId, quantity: { $gt: 0 } } as any)
    filter.id = { $in: stockHere.map((s: any) => s.productId) }
  }
  // Several articles at once, as the bill and goods-receipt forms seed their lines (`productsForSeed`).
  if (query.ids) filter.id = { $in: idList(query.ids) }

  // The new filters AND with every other one, so each narrows the ids already in force.
  if (supplierIds.length || noSupplier || byStock) {
    let restrict: Set<string> | null = Array.isArray(filter.id?.$in) ? new Set(filter.id.$in.map(String)) : null
    const narrow = (ids: Iterable<string>) => {
      const next = new Set(ids)
      restrict = restrict ? new Set([...restrict].filter((id) => next.has(id))) : next
    }
    if (supplierIds.length) narrow(await findProductIdsBySuppliers(orgId, supplierIds))
    if (noSupplier) narrow(await findProductIdsWithoutSupplier(orgId))
    if (restrict) filter.id = { $in: [...(restrict as Set<string>)] }
    if (byStock) filter.id = { $in: [...await productIdsPassingStockFilter(r.products, orgId, filter, stock)] }
  }
  return { filter, stock }
}
