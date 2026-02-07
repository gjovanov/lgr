import { JournalEntry, type IJournalEntry } from 'db/models'
import { BaseDao } from '../base.dao.js'

class JournalEntryDaoClass extends BaseDao<IJournalEntry> {
  constructor() {
    super(JournalEntry)
  }

  async findByDateRange(orgId: string, startDate: Date, endDate: Date): Promise<IJournalEntry[]> {
    return this.model.find({ orgId, date: { $gte: startDate, $lte: endDate } }).sort({ date: -1 }).exec()
  }

  async findByStatus(orgId: string, status: string): Promise<IJournalEntry[]> {
    return this.model.find({ orgId, status }).sort({ date: -1 }).exec()
  }

  async findByAccount(orgId: string, accountId: string): Promise<IJournalEntry[]> {
    return this.model.find({ orgId, 'lines.accountId': accountId }).sort({ date: -1 }).exec()
  }

  async findByPeriod(orgId: string, fiscalPeriodId: string): Promise<IJournalEntry[]> {
    return this.model.find({ orgId, fiscalPeriodId }).sort({ date: -1 }).exec()
  }

  async getNextEntryNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `JE-${year}-`
    const latest = await this.model
      .findOne({ orgId, entryNumber: { $regex: `^${prefix}` } })
      .sort({ entryNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.entryNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const journalEntryDao = new JournalEntryDaoClass()
