import { InventoryCount, type IInventoryCount } from 'db/models'
import { BaseDao } from '../base.dao.js'

class InventoryCountDaoClass extends BaseDao<IInventoryCount> {
  constructor() {
    super(InventoryCount)
  }

  async findByWarehouse(orgId: string, warehouseId: string): Promise<IInventoryCount[]> {
    return this.model.find({ orgId, warehouseId }).sort({ date: -1 }).exec()
  }

  async getNextCountNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `IC-${year}-`
    const latest = await this.model
      .findOne({ orgId, countNumber: { $regex: `^${prefix}` } })
      .sort({ countNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.countNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const inventoryCountDao = new InventoryCountDaoClass()
