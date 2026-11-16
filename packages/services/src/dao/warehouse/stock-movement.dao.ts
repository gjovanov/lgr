import { StockMovement, type IStockMovement } from 'db/models'
import { BaseDao } from '../base.dao.js'
import { nextMovementNumber } from '../../biz/movement-number.js'

class StockMovementDaoClass extends BaseDao<IStockMovement> {
  constructor() {
    super(StockMovement)
  }

  async findByType(orgId: string, type: string): Promise<IStockMovement[]> {
    return this.model.find({ orgId, type }).sort({ date: -1 }).exec()
  }

  async findByProduct(orgId: string, productId: string): Promise<IStockMovement[]> {
    return this.model.find({ orgId, 'lines.productId': productId }).sort({ date: -1 }).exec()
  }

  async findByDateRange(orgId: string, startDate: Date, endDate: Date): Promise<IStockMovement[]> {
    return this.model
      .find({ orgId, date: { $gte: startDate, $lte: endDate } })
      .sort({ date: -1 })
      .exec()
  }

  /**
   * The org's next number: read, not reserved. Nothing in the app numbers a movement by this any more (it writes
   * through `biz/movement-number`, which tries again when the number is taken); the tests' fixtures still do.
   */
  async getNextMovementNumber(orgId: string): Promise<string> {
    return nextMovementNumber(orgId)
  }
}

export const stockMovementDao = new StockMovementDaoClass()
