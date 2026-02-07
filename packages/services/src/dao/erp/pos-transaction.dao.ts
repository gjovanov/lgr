import { POSTransaction, type IPOSTransaction } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PosTransactionDaoClass extends BaseDao<IPOSTransaction> {
  constructor() {
    super(POSTransaction)
  }

  async findBySession(orgId: string, sessionId: string): Promise<IPOSTransaction[]> {
    return this.model.find({ orgId, sessionId }).sort({ createdAt: -1 }).exec()
  }

  async getNextTransactionNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `TXN-${year}-`
    const latest = await this.model
      .findOne({ orgId, transactionNumber: { $regex: `^${prefix}` } })
      .sort({ transactionNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.transactionNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const posTransactionDao = new PosTransactionDaoClass()
