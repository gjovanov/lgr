import { Product, type IProduct } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ProductDaoClass extends BaseDao<IProduct> {
  constructor() {
    super(Product)
  }

  async findBySku(orgId: string, sku: string): Promise<IProduct | null> {
    return this.model.findOne({ orgId, sku }).exec()
  }

  async findByBarcode(orgId: string, barcode: string): Promise<IProduct | null> {
    return this.model.findOne({ orgId, barcode }).exec()
  }

  async findByCategory(orgId: string, category: string): Promise<IProduct[]> {
    return this.model.find({ orgId, category }).exec()
  }

  async search(orgId: string, query: string): Promise<IProduct[]> {
    return this.model
      .find({ orgId, $text: { $search: query } })
      .sort({ score: { $meta: 'textScore' } })
      .exec()
  }

  async findLowStock(orgId: string): Promise<IProduct[]> {
    const products = await this.model
      .find({
        orgId,
        trackInventory: true,
        minStockLevel: { $exists: true, $gt: 0 },
      })
      .lean()
      .exec()

    if (products.length === 0) return []

    const { StockLevel } = await import('db/models')
    const productIds = products.map(p => p._id)

    // Single batch query instead of N individual queries
    const stockLevels = await StockLevel.find({
      orgId,
      productId: { $in: productIds },
    }).lean().exec()

    // Group stock totals by productId
    const stockByProduct = new Map<string, number>()
    for (const sl of stockLevels) {
      const key = sl.productId.toString()
      stockByProduct.set(key, (stockByProduct.get(key) ?? 0) + sl.quantity)
    }

    return products.filter(product => {
      const totalQty = stockByProduct.get(product._id.toString()) ?? 0
      return totalQty < (product.minStockLevel ?? 0)
    }) as IProduct[]
  }
}

export const productDao = new ProductDaoClass()
