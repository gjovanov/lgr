import { BillOfMaterials, type IBillOfMaterials } from 'db/models'
import { BaseDao } from '../base.dao.js'

class BomDaoClass extends BaseDao<IBillOfMaterials> {
  constructor() {
    super(BillOfMaterials)
  }

  async findByProduct(orgId: string, productId: string): Promise<IBillOfMaterials[]> {
    return this.model.find({ orgId, productId }).exec()
  }

  async findActive(orgId: string): Promise<IBillOfMaterials[]> {
    return this.model.find({ orgId, status: 'active' }).exec()
  }
}

export const bomDao = new BomDaoClass()
