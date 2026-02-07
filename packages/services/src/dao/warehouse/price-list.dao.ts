import { PriceList, type IPriceList } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PriceListDaoClass extends BaseDao<IPriceList> {
  constructor() {
    super(PriceList)
  }

  async findDefault(orgId: string): Promise<IPriceList | null> {
    return this.model.findOne({ orgId, isDefault: true }).exec()
  }

  async findActive(orgId: string): Promise<IPriceList[]> {
    return this.model.find({ orgId, isActive: true }).exec()
  }

  async findPriceForProduct(
    orgId: string,
    productId: string,
    priceListId?: string,
  ): Promise<IPriceList | null> {
    const filter: Record<string, unknown> = {
      orgId,
      isActive: true,
      'items.productId': productId,
    }
    if (priceListId) {
      filter._id = priceListId
    } else {
      filter.isDefault = true
    }
    return this.model.findOne(filter).exec()
  }
}

export const priceListDao = new PriceListDaoClass()
