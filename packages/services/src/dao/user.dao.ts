import { User, type IUser } from 'db/models'
import { BaseDao } from './base.dao.js'

class UserDaoClass extends BaseDao<IUser> {
  constructor() {
    super(User)
  }

  async findByOrgId(orgId: string): Promise<IUser[]> {
    return this.model.find({ orgId }).select('-password').exec()
  }

  async findByEmail(email: string, orgId: string): Promise<IUser | null> {
    return this.model.findOne({ email, orgId }).exec()
  }

  async findByUsername(username: string, orgId: string): Promise<IUser | null> {
    return this.model.findOne({ username, orgId }).exec()
  }

  async findByUsernameAndOrgSlug(username: string, orgSlug: string): Promise<IUser | null> {
    const { Org } = await import('db/models')
    const org = await Org.findOne({ slug: orgSlug }).exec()
    if (!org) return null
    return this.model.findOne({ username, orgId: org._id }).exec()
  }

  async findByIdSafe(id: string): Promise<IUser | null> {
    return this.model.findById(id).select('-password').exec()
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { lastLoginAt: new Date() }).exec()
  }
}

export const userDao = new UserDaoClass()
