import { LeaveType, type ILeaveType } from 'db/models'
import { BaseDao } from '../base.dao.js'

class LeaveTypeDaoClass extends BaseDao<ILeaveType> {
  constructor() {
    super(LeaveType)
  }

  async findByCode(orgId: string, code: string): Promise<ILeaveType | null> {
    return this.model.findOne({ orgId, code }).exec()
  }

  async findActive(orgId: string): Promise<ILeaveType[]> {
    return this.model.find({ orgId, isActive: true }).exec()
  }
}

export const leaveTypeDao = new LeaveTypeDaoClass()
