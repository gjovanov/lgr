import { ConstructionProject, type IConstructionProject } from 'db/models'
import { BaseDao } from '../base.dao.js'

class ConstructionProjectDaoClass extends BaseDao<IConstructionProject> {
  constructor() {
    super(ConstructionProject)
  }

  async findByClient(orgId: string, clientId: string): Promise<IConstructionProject[]> {
    return this.model.find({ orgId, clientId }).sort({ createdAt: -1 }).exec()
  }

  async findByStatus(orgId: string, status: string): Promise<IConstructionProject[]> {
    return this.model.find({ orgId, status }).sort({ startDate: -1 }).exec()
  }

  async getNextProjectNumber(orgId: string): Promise<string> {
    const year = new Date().getFullYear()
    const prefix = `CP-${year}-`
    const latest = await this.model
      .findOne({ orgId, projectNumber: { $regex: `^${prefix}` } })
      .sort({ projectNumber: -1 })
      .exec()
    if (!latest) {
      return `${prefix}00001`
    }
    const currentNum = parseInt(latest.projectNumber.replace(prefix, ''), 10)
    return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
  }
}

export const constructionProjectDao = new ConstructionProjectDaoClass()
