import { InventoryCount, type IInventoryCount } from 'db/models'
import { BaseDao } from '../base.dao.js'

class InventoryCountDaoClass extends BaseDao<IInventoryCount> {
  constructor() {
    super(InventoryCount)
  }

  async findByWarehouse(orgId: string, warehouseId: string): Promise<IInventoryCount[]> {
    return this.model.find({ orgId, warehouseId }).sort({ date: -1 }).exec()
  }
  // A count's number is `biz/count-number` (#713). The latest + 1 that stood here was called by nothing.
}

export const inventoryCountDao = new InventoryCountDaoClass()
