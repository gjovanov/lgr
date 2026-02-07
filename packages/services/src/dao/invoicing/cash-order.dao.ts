import { CashOrder, type ICashOrder } from 'db/models'
import { BaseDao } from '../base.dao.js'

class CashOrderDaoClass extends BaseDao<ICashOrder> {
  constructor() {
    super(CashOrder)
  }

  async getNextOrderNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `CO-${year}-`
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

export const cashOrderDao = new CashOrderDaoClass()
