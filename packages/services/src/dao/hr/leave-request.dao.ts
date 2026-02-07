import { LeaveRequest, type ILeaveRequest } from 'db/models'
import { BaseDao } from '../base.dao.js'

class LeaveRequestDaoClass extends BaseDao<ILeaveRequest> {
  constructor() {
    super(LeaveRequest)
  }

  async findByEmployee(orgId: string, employeeId: string): Promise<ILeaveRequest[]> {
    return this.model.find({ orgId, employeeId }).sort({ startDate: -1 }).exec()
  }

  async findByStatus(orgId: string, status: string): Promise<ILeaveRequest[]> {
    return this.model.find({ orgId, status }).sort({ startDate: -1 }).exec()
  }

  async findByDateRange(orgId: string, startDate: Date, endDate: Date): Promise<ILeaveRequest[]> {
    return this.model
      .find({
        orgId,
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      })
      .sort({ startDate: -1 })
      .exec()
  }

  async findPending(orgId: string): Promise<ILeaveRequest[]> {
    return this.model.find({ orgId, status: 'pending' }).sort({ createdAt: -1 }).exec()
  }
}

export const leaveRequestDao = new LeaveRequestDaoClass()
