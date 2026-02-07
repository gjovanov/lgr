import { FiscalYear, type IFiscalYear } from 'db/models'
import { BaseDao } from '../base.dao.js'

class FiscalYearDaoClass extends BaseDao<IFiscalYear> {
  constructor() {
    super(FiscalYear)
  }

  async findCurrent(orgId: string): Promise<IFiscalYear | null> {
    return this.model.findOne({ orgId, status: 'open' }).exec()
  }

  async findByDateRange(orgId: string, date: Date): Promise<IFiscalYear | null> {
    return this.model.findOne({ orgId, startDate: { $lte: date }, endDate: { $gte: date } }).exec()
  }
}

export const fiscalYearDao = new FiscalYearDaoClass()
