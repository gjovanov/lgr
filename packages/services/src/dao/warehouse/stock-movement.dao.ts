import { StockMovement, type IStockMovement } from 'db/models'
import { BaseDao } from '../base.dao.js'

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

  async getNextMovementNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `SM-${year}-`
    const latest = await this.model
      .findOne({ orgId, movementNumber: { $regex: `^${prefix}` } })
      .sort({ movementNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.movementNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const stockMovementDao = new StockMovementDaoClass()
