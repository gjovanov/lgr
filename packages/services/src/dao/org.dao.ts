import { Org, type IOrg } from 'db/models'
import { BaseDao } from './base.dao.js'

class OrgDaoClass extends BaseDao<IOrg> {
  constructor() {
    super(Org)
  }

  async findBySlug(slug: string): Promise<IOrg | null> {
    return this.model.findOne({ slug }).exec()
  }

  async findByOwnerId(ownerId: string): Promise<IOrg[]> {
    return this.model.find({ ownerId }).exec()
  }
}

export const orgDao = new OrgDaoClass()
