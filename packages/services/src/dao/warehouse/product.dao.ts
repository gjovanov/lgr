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

  // FR-30.4: `search`, a `$text` query nothing called, went with the text index it needed. The search is
  // `buildProductSearchFilter` (`services/biz/search.utils.ts`).

  // FR-28.5: `findLowStock` lived here, with no caller and no test, as a third definition of "below minimum"
  // beside the Reports `stock-levels` rule. The one definition is `services/biz/product-stock-filter.ts`
  // (`passesStockFilter`, `productIdsPassingStockFilter`), which the Products list and the Stock-levels
  // page both read.
}

export const productDao = new ProductDaoClass()
