import { Pipeline, type IPipeline } from 'db/models'
import { BaseDao } from '../base.dao.js'

class PipelineDaoClass extends BaseDao<IPipeline> {
  constructor() {
    super(Pipeline)
  }

  async findDefault(orgId: string): Promise<IPipeline | null> {
    return this.model.findOne({ orgId, isDefault: true }).exec()
  }

  async findActive(orgId: string): Promise<IPipeline[]> {
    return this.model.find({ orgId, isActive: true }).exec()
  }
}

export const pipelineDao = new PipelineDaoClass()
