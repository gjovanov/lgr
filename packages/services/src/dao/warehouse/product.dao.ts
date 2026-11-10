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

  // FR-28.5: `findLowStock` lived here, with no caller and no test, as a third definition of "below minimum"
  // beside the Reports `stock-levels` rule. The one definition is `services/biz/product-stock-filter.ts`
  // (`passesStockFilter`, `productIdsPassingStockFilter`), which the Products list and the Stock-levels
  // page both read.
}

export const productDao = new ProductDaoClass()
