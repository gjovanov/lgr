import { ProductionOrder, type IProductionOrder } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ProductionOrderDaoClass extends BaseDao<IProductionOrder> {
  constructor() {
    super(ProductionOrder)
  }

  async findByStatus(orgId: string, status: string): Promise<IProductionOrder[]> {
    return this.model.find({ orgId, status }).sort({ plannedStartDate: 1 }).exec()
  }

  async findByProduct(orgId: string, productId: string): Promise<IProductionOrder[]> {
    return this.model.find({ orgId, productId }).sort({ createdAt: -1 }).exec()
  }

  async getNextOrderNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `PRD-${year}-`
    const latest = await this.model
      .findOne({ orgId, orderNumber: { $regex: `^${prefix}` } })
      .sort({ orderNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.orderNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const productionOrderDao = new ProductionOrderDaoClass()
