import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { buildProductSearchFilter } from 'services/biz/search.utils'
import { productSearchFieldComplete } from 'services/biz/product-search-field'
import { getProductsSupplyTotals } from 'services/biz/product-supply.service'
import { grantOf } from 'services/biz/access/evaluate'
import { redactStockCost } from 'config/access'
import { productIdsPassingStockFilter } from 'services/biz/product-stock-filter'
import { chooseListSort } from 'config/list-sorts'
import { COUNT_FIELDS, listProjection } from 'config/list-rows'

export const stockLevelController = new Elysia({ prefix: '/org/:orgId/warehouse/stock-level' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.productId) filter.productId = query.productId

    // Build product filter from category, search, and tags
    const productFilter: Record<string, any> = { orgId }
    let needProductLookup = false
    if (query.category) { productFilter.category = query.category; needProductLookup = true }
    if (query.search) {
      // FR-30.13: the Products list's search (its lowered, indexed field, so Cyrillic is found whatever its case), not a
      // case-insensitive pattern over the name, SKU and barcode.
      Object.assign(productFilter, buildProductSearchFilter(query.search as string, { complete: await productSearchFieldComplete(orgId) }))
      needProductLookup = true
    }
    if (query.tags) {
      const tags = String(query.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
      if (tags.length) { productFilter.tags = { $in: tags }; needProductLookup = true }
    }
    if (needProductLookup) {
      // The matching articles' ids, not the articles (FR-30.13).
      const products = await r.products.findMany(productFilter, undefined, { select: ['id'] })
      filter.productId = { $in: products.map(p => p.id) }
    }
    // FR-28.5: the page's „low stock only" switch is the Products list's „below minimum" — one definition
    // (`product-stock-filter.ts`), where the page sent a parameter nothing read. With a warehouse chosen it is
    // that warehouse's quantity against the minimum; without, the article's total.
    if (query.lowStockOnly === 'true' || query.lowStockOnly === '1') {
      const low = await productIdsPassingStockFilter(r.products, orgId, { orgId } as any, {
        belowMin: true,
        warehouseId: query.warehouseId ? String(query.warehouseId) : undefined,
      })
      const named: string[] | null = filter.productId?.$in ? filter.productId.$in.map(String) : filter.productId ? [String(filter.productId)] : null
      filter.productId = { $in: (named ?? [...low]).filter((id) => low.has(id)) }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // FR-30.2: a sort the list declares (`config/list-sorts`), else the list's default.
    const sort = chooseListSort('stockLevels', query.sortBy, query.sortOrder)

    // FR-30.8: the count form's lean "all" (`fields=count`) is the one answer past the ceiling, and it is narrow: a count
    // of a warehouse lists every level in it. Anything else is a list's page, cut at the ceiling.
    const lean = query.fields === COUNT_FIELDS
    const result = await r.stockLevels.findAll(
      filter,
      { page, size, sort: { [sort.field]: sort.order }, unbounded: lean },
      { select: lean ? ['productId', 'warehouseId', 'quantity', 'avgCost'] : listProjection('stockLevels', query.fields) },
    )

    // Manual lookups to replace .populate()
    const productIds = new Set<string>()
    const warehouseIds = new Set<string>()
    for (const sl of result.items) {
      if (sl.productId) productIds.add(sl.productId)
      if (sl.warehouseId) warehouseIds.add(sl.warehouseId)
    }

    const [products, warehouses] = await Promise.all([
      // A row takes the article's name and SKU and the warehouse's name: the articles were read whole (FR-30.7).
      // The count form's lean read takes the barcode too: its line filter reads name, SKU and barcode (FR-33.2).
      productIds.size > 0 ? r.products.findMany({ orgId, id: { $in: [...productIds] } } as any, undefined, { select: lean ? ['sku', 'name', 'unit', 'barcode'] : ['sku', 'name'] }) : [],
      warehouseIds.size > 0 ? r.warehouses.findMany({ orgId, id: { $in: [...warehouseIds] } } as any, undefined, { select: ['name'] }) : [],
    ])

    const productMap = new Map(products.map(p => [p.id, p]))
    const warehouseMap = new Map(warehouses.map(w => [w.id, w]))

    // FR-27.6: a stock level's average cost is a cost figure.
    const grant = grantOf(user as any)
    const stockLevels = result.items.map(sl => {
      const product = productMap.get(sl.productId)
      const warehouse = warehouseMap.get(sl.warehouseId)
      return {
        ...redactStockCost(grant, sl as any),
        productSku: product?.sku || '',
        productName: product?.name || '',
        ...(lean ? { productUnit: product?.unit || '', productBarcode: product?.barcode || '' } : {}),
        warehouseName: warehouse?.name || '',
      }
    })

    return { stockLevels, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages, ...(result.truncated ? { truncated: true } : {}) }
  }, { isSignIn: true })
  // Bulk per-warehouse stock for a set of products — powers the products-grid quantity badges
  // without an N+1 (one call per rendered page). Returns { stock: { [productId]: [{ warehouse… }] } }.
  //
  // FR-22.45: the same call carries each product's „Резервирано" / „Поръчано" (`supply`), from
  // the definitions the product's stock tab uses (`getProductsSupplyTotals`). With `warehouseId`
  // (the list's warehouse filter) the badges and the totals both describe that warehouse only, so
  // a row never shows one warehouse's stock beside another's holds.
  .get('/by-products', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const ids = String(query.productIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!ids.length) return { stock: {}, supply: {} }
    const warehouseId = query.warehouseId ? String(query.warehouseId) : ''

    const [rows, supply] = await Promise.all([
      r.stockLevels.findMany({ orgId, productId: { $in: ids }, ...(warehouseId ? { warehouseId } : {}) } as any),
      getProductsSupplyTotals(orgId, ids, { warehouseId: warehouseId || undefined }),
    ])
    const whIds = [...new Set(rows.map((s: any) => s.warehouseId).filter(Boolean))]
    const warehouses = whIds.length ? await r.warehouses.findMany({ orgId, id: { $in: whIds } } as any) : []
    const whMap = new Map(warehouses.map((w: any) => [w.id, w.name]))

    const stock: Record<string, any[]> = {}
    for (const s of rows) {
      if (!s.productId) continue
      if (!stock[s.productId]) stock[s.productId] = []
      stock[s.productId].push({
        warehouseId: s.warehouseId,
        warehouseName: whMap.get(s.warehouseId) || '',
        quantity: s.quantity ?? 0,
        availableQuantity: s.availableQuantity ?? s.quantity ?? 0,
      })
    }
    return { stock, supply }
  }, { isSignIn: true })
