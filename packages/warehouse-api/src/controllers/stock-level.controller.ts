import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { StockLevel, Product, Warehouse } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const stockLevelController = new Elysia({ prefix: '/org/:orgId/warehouse/stock-level' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    if (query.warehouseId) filter.warehouseId = query.warehouseId
    if (query.productId) filter.productId = query.productId
    if (query.category) {
      const products = await Product.find({ orgId, category: query.category }).select('_id').lean().exec()
      filter.productId = { $in: products.map((p: any) => p._id) }
    }
    const result = await paginateQuery(StockLevel, filter, query)
    const populated = await StockLevel.populate(result.items, [
      { path: 'productId', select: 'sku name' },
      { path: 'warehouseId', select: 'name' },
    ])
    const stockLevels = populated.map((sl: any) => ({
      ...sl,
      productSku: sl.productId?.sku || '',
      productName: sl.productId?.name || '',
      warehouseName: sl.warehouseId?.name || '',
      productId: sl.productId?._id || sl.productId,
      warehouseId: sl.warehouseId?._id || sl.warehouseId,
    }))
    return { stockLevels, total: result.total, page: result.page, size: result.size, totalPages: result.totalPages }
  }, { isSignIn: true })
