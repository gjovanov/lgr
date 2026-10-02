import type { UpdateQuery } from 'mongoose'
import { mongoose } from 'db/connection'
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

  /**
   * One user of ONE org, without the password hash — `null` when the id is malformed or the user
   * belongs to any other org.
   *
   * ⚠ S-21. This was `findByIdSafe(id)`, and the `/org/:orgId/user/:userId` routes used it with
   * the id from the URL. The tenant guard only proves the caller belongs to `:orgId` — their own
   * org — so `/org/<mine>/user/<yours>` read, rewrote and deactivated another org's users,
   * password included. The org is part of the lookup now, so a foreign id is simply not found.
   */
  async findInOrg(id: string, orgId: string): Promise<IUser | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) return null
    return this.model.findOne({ _id: id, orgId }).select('-password').exec()
  }

  /** `findInOrg`'s write twin: updates only a user of `orgId`, and never returns the hash. */
  async updateInOrg(id: string, orgId: string, data: UpdateQuery<IUser>): Promise<IUser | null> {
    if (!mongoose.Types.ObjectId.isValid(id)) return null
    return this.model
      .findOneAndUpdate({ _id: id, orgId }, data, { new: true })
      .select('-password')
      .exec()
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.model.findByIdAndUpdate(id, { lastLoginAt: new Date() }).exec()
  }
}

export const userDao = new UserDaoClass()
