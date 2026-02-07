import { FiscalPeriod, type IFiscalPeriod } from 'db/models'
import { BaseDao } from '../base.dao.js'

class FiscalPeriodDaoClass extends BaseDao<IFiscalPeriod> {
  constructor() {
    super(FiscalPeriod)
  }

  async findByYear(orgId: string, fiscalYearId: string): Promise<IFiscalPeriod[]> {
    return this.model.find({ orgId, fiscalYearId }).sort({ number: 1 }).exec()
  }

  async findCurrent(orgId: string): Promise<IFiscalPeriod | null> {
    const now = new Date()
    return this.model
      .findOne({ orgId, status: 'open', startDate: { $lte: now }, endDate: { $gte: now } })
      .exec()
  }

  async findByDate(orgId: string, date: Date): Promise<IFiscalPeriod | null> {
    return this.model.findOne({ orgId, startDate: { $lte: date }, endDate: { $gte: date } }).exec()
  }
}

export const fiscalPeriodDao = new FiscalPeriodDaoClass()
