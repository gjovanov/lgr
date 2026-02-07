import { PayrollRun, type IPayrollRun } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PayrollRunDaoClass extends BaseDao<IPayrollRun> {
  constructor() {
    super(PayrollRun)
  }

  async findByPeriod(orgId: string, from: Date, to: Date): Promise<IPayrollRun[]> {
    return this.model
      .find({ orgId, 'period.from': { $gte: from }, 'period.to': { $lte: to } })
      .sort({ 'period.from': -1 })
      .exec()
  }

  async findByStatus(orgId: string, status: string): Promise<IPayrollRun[]> {
    return this.model.find({ orgId, status }).sort({ 'period.from': -1 }).exec()
  }
}

export const payrollRunDao = new PayrollRunDaoClass()
