import { FixedAsset, type IFixedAsset } from 'db/models'
import { BaseDao } from '../base.dao.js'

class FixedAssetDaoClass extends BaseDao<IFixedAsset> {
  constructor() {
    super(FixedAsset)
  }

  async findByCategory(orgId: string, category: string): Promise<IFixedAsset[]> {
    return this.model.find({ orgId, category }).exec()
  }

  async findActive(orgId: string): Promise<IFixedAsset[]> {
    return this.model.find({ orgId, status: 'active' }).exec()
  }
}

export const fixedAssetDao = new FixedAssetDaoClass()
