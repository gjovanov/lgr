import { Lead, type ILead } from 'db/models'
import { BaseDao } from '../base.dao.js'

class LeadDaoClass extends BaseDao<ILead> {
  constructor() {
    super(Lead)
  }

  async findByStatus(orgId: string, status: string): Promise<ILead[]> {
    return this.model.find({ orgId, status }).sort({ createdAt: -1 }).exec()
  }

  async findByAssignee(orgId: string, userId: string): Promise<ILead[]> {
    return this.model.find({ orgId, assignedTo: userId }).sort({ createdAt: -1 }).exec()
  }

  async findBySource(orgId: string, source: string): Promise<ILead[]> {
    return this.model.find({ orgId, source }).sort({ createdAt: -1 }).exec()
  }
}

export const leadDao = new LeadDaoClass()
