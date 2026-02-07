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
    return this.model
      .find({
        orgId,
        trackInventory: true,
        minStockLevel: { $exists: true, $gt: 0 },
      })
      .exec()
      .then(async (products) => {
        const { StockLevel } = await import('db/models')
        const results: IProduct[] = []
        for (const product of products) {
          const stockLevels = await StockLevel.find({ orgId, productId: product._id }).exec()
          const totalQty = stockLevels.reduce((sum, sl) => sum + sl.quantity, 0)
          if (totalQty < (product.minStockLevel ?? 0)) {
            results.push(product)
          }
        }
        return results
      })
  }
}

export const productDao = new ProductDaoClass()
