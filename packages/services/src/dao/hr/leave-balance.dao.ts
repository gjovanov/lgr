import { LeaveBalance, type ILeaveBalance } from 'db/models'
import { BaseDao } from '../base.dao.js'

class LeaveBalanceDaoClass extends BaseDao<ILeaveBalance> {
  constructor() {
    super(LeaveBalance)
  }

  async findByEmployee(orgId: string, employeeId: string, year: number): Promise<ILeaveBalance[]> {
    return this.model.find({ orgId, employeeId, year }).exec()
  }

  async findByLeaveType(
    orgId: string,
    leaveTypeId: string,
    year: number,
  ): Promise<ILeaveBalance[]> {
    return this.model.find({ orgId, leaveTypeId, year }).exec()
  }
}

export const leaveBalanceDao = new LeaveBalanceDaoClass()
