import { Deal, type IDeal } from 'db/models'
import { BaseDao } from '../base.dao.js'

class DealDaoClass extends BaseDao<IDeal> {
  constructor() {
    super(Deal)
  }

  async findByPipeline(orgId: string, pipelineId: string): Promise<IDeal[]> {
    return this.model.find({ orgId, pipelineId }).sort({ createdAt: -1 }).exec()
  }

  async findByStage(orgId: string, pipelineId: string, stage: string): Promise<IDeal[]> {
    return this.model.find({ orgId, pipelineId, stage }).sort({ createdAt: -1 }).exec()
  }

  async findByContact(orgId: string, contactId: string): Promise<IDeal[]> {
    return this.model.find({ orgId, contactId }).sort({ createdAt: -1 }).exec()
  }

  async findByStatus(orgId: string, status: string): Promise<IDeal[]> {
    return this.model.find({ orgId, status }).sort({ createdAt: -1 }).exec()
  }

  async findByAssignee(orgId: string, userId: string): Promise<IDeal[]> {
    return this.model.find({ orgId, assignedTo: userId }).sort({ createdAt: -1 }).exec()
  }
}

export const dealDao = new DealDaoClass()
