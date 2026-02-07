import { Timesheet, type ITimesheet } from 'db/models'
import { BaseDao } from '../base.dao.js'

class TimesheetDaoClass extends BaseDao<ITimesheet> {
  constructor() {
    super(Timesheet)
  }

  async findByEmployee(orgId: string, employeeId: string): Promise<ITimesheet[]> {
    return this.model.find({ orgId, employeeId }).sort({ date: -1 }).exec()
  }

  async findByDateRange(
    orgId: string,
    employeeId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<ITimesheet[]> {
    return this.model
      .find({ orgId, employeeId, date: { $gte: startDate, $lte: endDate } })
      .sort({ date: -1 })
      .exec()
  }

  async findByStatus(orgId: string, status: string): Promise<ITimesheet[]> {
    return this.model.find({ orgId, status }).sort({ date: -1 }).exec()
  }
}

export const timesheetDao = new TimesheetDaoClass()
