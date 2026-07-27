import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { buildSearchFilter } from 'services/biz/search.utils'

export const stockLevelController = new Elysia({ prefix: '/org/:orgId/warehouse/stock-level' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.productId) filter.productId = query.productId

    // Build product filter from category, search, and tags
    const productFilter: Record<string, any> = { orgId }
    let needProductLookup = false
    if (query.category) { productFilter.category = query.category; needProductLookup = true }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'sku', 'barcode'], { hasTextIndex: true })
      Object.assign(productFilter, searchFilter)
      needProductLookup = true
    }
    if (query.tags) {
      const tags = String(query.tags).split(',').map((t: string) => t.trim()).filter(Boolean)
      if (tags.length) { productFilter.tags = { $in: tags }; needProductLookup = true }
    }
    if (needProductLookup) {
      const products = await r.products.findMany(productFilter)
      filter.productId = { $in: products.map(p => p.id) }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.stockLevels.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Manual lookups to replace .populate()
    const productIds = new Set<string>()
    const warehouseIds = new Set<string>()
    for (const sl of result.items) {
      if (sl.productId) productIds.add(sl.productId)
      if (sl.warehouseId) warehouseIds.add(sl.warehouseId)
    }

    const [products, warehouses] = await Promise.all([
      productIds.size > 0 ? r.products.findMany({ id: { $in: [...productIds] } } as any) : [],
      warehouseIds.size > 0 ? r.warehouses.findMany({ id: { $in: [...warehouseIds] } } as any) : [],
    ])

    const productMap = new Map(products.map(p => [p.id, p]))
    const warehouseMap = new Map(warehouses.map(w => [w.id, w]))

    const stockLevels = result.items.map(sl => {
      const product = productMap.get(sl.productId)
      const warehouse = warehouseMap.get(sl.warehouseId)
      return {
        ...sl,
        productSku: product?.sku || '',
        productName: product?.name || '',
        warehouseName: warehouse?.name || '',
      }
    })

    return { stockLevels, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
  // Bulk per-warehouse stock for a set of products — powers the products-grid quantity badges
  // without an N+1 (one call per rendered page). Returns { stock: { [productId]: [{ warehouse… }] } }.
  .get('/by-products', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const ids = String(query.productIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (!ids.length) return { stock: {} }

    const rows = await r.stockLevels.findMany({ orgId, productId: { $in: ids } } as any)
    const whIds = [...new Set(rows.map((s: any) => s.warehouseId).filter(Boolean))]
    const warehouses = whIds.length ? await r.warehouses.findMany({ id: { $in: whIds } } as any) : []
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
    return { stock }
  }, { isSignIn: true })
