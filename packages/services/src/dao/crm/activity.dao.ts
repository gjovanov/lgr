import { Activity, type IActivity } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ActivityDaoClass extends BaseDao<IActivity> {
  constructor() {
    super(Activity)
  }

  async findByContact(orgId: string, contactId: string): Promise<IActivity[]> {
    return this.model.find({ orgId, contactId }).sort({ createdAt: -1 }).exec()
  }

  async findByDeal(orgId: string, dealId: string): Promise<IActivity[]> {
    return this.model.find({ orgId, dealId }).sort({ createdAt: -1 }).exec()
  }

  async findByAssignee(orgId: string, userId: string): Promise<IActivity[]> {
    return this.model.find({ orgId, assignedTo: userId }).sort({ dueDate: 1 }).exec()
  }

  async findPending(orgId: string): Promise<IActivity[]> {
    return this.model.find({ orgId, status: 'pending' }).sort({ dueDate: 1 }).exec()
  }

  async findOverdue(orgId: string): Promise<IActivity[]> {
    const now = new Date()
    return this.model
      .find({
        orgId,
        status: 'pending',
        dueDate: { $lt: now },
      })
      .sort({ dueDate: 1 })
      .exec()
  }
}

export const activityDao = new ActivityDaoClass()
