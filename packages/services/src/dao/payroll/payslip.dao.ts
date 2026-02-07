import { Payslip, type IPayslip } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PayslipDaoClass extends BaseDao<IPayslip> {
  constructor() {
    super(Payslip)
  }

  async findByEmployee(orgId: string, employeeId: string): Promise<IPayslip[]> {
    return this.model.find({ orgId, employeeId }).sort({ 'period.from': -1 }).exec()
  }

  async findByPayrollRun(orgId: string, payrollRunId: string): Promise<IPayslip[]> {
    return this.model.find({ orgId, payrollRunId }).exec()
  }
}

export const payslipDao = new PayslipDaoClass()
