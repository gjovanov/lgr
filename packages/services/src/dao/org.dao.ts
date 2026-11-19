import type { Types } from 'mongoose'
import { Org, type IOrg } from 'db/models'
import { BaseDao } from './base.dao.js'

class OrgDaoClass extends BaseDao<IOrg> {
  constructor() {
    super(Org)
  }

  /**
   * An org as a plain object WITH the model's defaults. The base class reads lean: this one does not.
   *
   * An org's document holds only the settings somebody saved, so a key the schema gained after the org was founded
   * is not in it. This is the read behind `GET /auth/me` and `GET /org/:orgId`, which every SPA takes the org's
   * settings from: a key that is not stored must answer what the model says it is (the VAT rate a new article gets,
   * the zone a till's day is read in). A lean read answers `undefined` there, and the page then sends nothing.
   * `org-read-defaults.flow.test.ts` holds it, on an org whose document lacks the keys.
   */
  async findById(id: string | Types.ObjectId): Promise<IOrg | null> {
    const org = await this.model.findById(id).exec()
    return org ? (org.toObject({ flattenMaps: true }) as unknown as IOrg) : null
  }

  async findBySlug(slug: string): Promise<IOrg | null> {
    return this.model.findOne({ slug }).exec()
  }

  async findByOwnerId(ownerId: string): Promise<IOrg[]> {
    return this.model.find({ ownerId }).exec()
  }
}

export const orgDao = new OrgDaoClass()
