import { TaxReturn, type ITaxReturn } from 'db/models'
import { BaseDao } from '../base.dao.js'

class TaxReturnDaoClass extends BaseDao<ITaxReturn> {
  constructor() {
    super(TaxReturn)
  }

  async findByType(orgId: string, type: string): Promise<ITaxReturn[]> {
    return this.model.find({ orgId, type }).sort({ 'period.from': -1 }).exec()
  }

  async findByPeriod(orgId: string, from: Date, to: Date): Promise<ITaxReturn[]> {
    return this.model
      .find({ orgId, 'period.from': { $gte: from }, 'period.to': { $lte: to } })
      .sort({ 'period.from': -1 })
      .exec()
  }
}

export const taxReturnDao = new TaxReturnDaoClass()
