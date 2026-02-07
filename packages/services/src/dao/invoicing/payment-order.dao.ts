import { PaymentOrder, type IPaymentOrder } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PaymentOrderDaoClass extends BaseDao<IPaymentOrder> {
  constructor() {
    super(PaymentOrder)
  }

  async findByContact(orgId: string, contactId: string): Promise<IPaymentOrder[]> {
    return this.model.find({ orgId, contactId }).sort({ createdAt: -1 }).exec()
  }

  async getNextOrderNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `PO-${year}-`
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

export const paymentOrderDao = new PaymentOrderDaoClass()
