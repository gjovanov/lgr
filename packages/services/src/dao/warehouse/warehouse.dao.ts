import { Warehouse, type IWarehouse } from 'db/models'
import { BaseDao } from '../base.dao.js'

class WarehouseDaoClass extends BaseDao<IWarehouse> {
  constructor() {
    super(Warehouse)
  }

  async findDefault(orgId: string): Promise<IWarehouse | null> {
    return this.model.findOne({ orgId, isDefault: true }).exec()
  }

  async findActive(orgId: string): Promise<IWarehouse[]> {
    return this.model.find({ orgId, isActive: true }).exec()
  }
}

export const warehouseDao = new WarehouseDaoClass()
