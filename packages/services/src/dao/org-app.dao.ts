import { OrgApp, type IOrgApp } from 'db/models'
import { BaseDao } from './base.dao.js'

class OrgAppDaoClass extends BaseDao<IOrgApp> {
  constructor() {
    super(OrgApp)
  }

  async findByOrg(orgId: string): Promise<IOrgApp[]> {
    return this.model.find({ orgId, enabled: true }).exec()
  }

  async findByOrgAndApp(orgId: string, appId: string): Promise<IOrgApp | null> {
    return this.model.findOne({ orgId, appId }).exec()
  }

  async activateApp(orgId: string, appId: string, userId: string): Promise<IOrgApp> {
    const existing = await this.model.findOne({ orgId, appId }).exec()
    if (existing) {
      existing.enabled = true
      existing.activatedAt = new Date()
      existing.activatedBy = userId as any
      return existing.save()
    }
    return this.create({
      orgId: orgId as any,
      appId,
      enabled: true,
      activatedAt: new Date(),
      activatedBy: userId as any,
    })
  }

  async deactivateApp(orgId: string, appId: string): Promise<IOrgApp | null> {
    return this.model
      .findOneAndUpdate(
        { orgId, appId },
        { $set: { enabled: false } },
        { new: true },
      )
      .exec()
  }

  async isAppEnabled(orgId: string, appId: string): Promise<boolean> {
    const doc = await this.model.findOne({ orgId, appId, enabled: true }).exec()
    return !!doc
  }
}

export const orgAppDao = new OrgAppDaoClass()
