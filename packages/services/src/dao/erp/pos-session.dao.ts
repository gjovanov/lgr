import { POSSession, type IPOSSession } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PosSessionDaoClass extends BaseDao<IPOSSession> {
  constructor() {
    super(POSSession)
  }

  async findOpen(orgId: string): Promise<IPOSSession[]> {
    return this.model.find({ orgId, status: 'open' }).sort({ openedAt: -1 }).exec()
  }

  async findByCashier(orgId: string, cashierId: string): Promise<IPOSSession[]> {
    return this.model.find({ orgId, cashierId }).sort({ openedAt: -1 }).exec()
  }

  async getNextSessionNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `POS-${year}-`
    const latest = await this.model
      .findOne({ orgId, sessionNumber: { $regex: `^${prefix}` } })
      .sort({ sessionNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.sessionNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const posSessionDao = new PosSessionDaoClass()
