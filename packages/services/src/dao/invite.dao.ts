import { Invite, type IInvite } from 'db/models'
import { BaseDao, type PaginatedResult } from './base.dao.js'
import { nanoid } from 'nanoid'

export interface CreateInviteParams {
  orgId: string
  inviterId: string
  targetEmail?: string
  maxUses?: number
  assignRole?: string
  expiresInHours?: number
}

class InviteDaoClass extends BaseDao<IInvite> {
  constructor() {
    super(Invite)
  }

  async createInvite(params: CreateInviteParams): Promise<IInvite> {
    const code = nanoid(21)
    const data: Partial<IInvite> = {
      code,
      orgId: params.orgId as any,
      inviterId: params.inviterId as any,
      status: 'active',
      useCount: 0,
      assignRole: params.assignRole || 'member',
    }

    if (params.targetEmail) {
      data.targetEmail = params.targetEmail
      data.maxUses = 1
    } else if (params.maxUses) {
      data.maxUses = params.maxUses
    }

    if (params.expiresInHours) {
      data.expiresAt = new Date(Date.now() + params.expiresInHours * 3600 * 1000)
    }

    return this.create(data)
  }

  async findByCode(code: string): Promise<IInvite | null> {
    return this.model.findOne({ code }).exec()
  }

  async listByOrg(
    orgId: string,
    page = 0,
    size = 10,
  ): Promise<PaginatedResult<IInvite>> {
    return this.findAll({ orgId } as any, page, size)
  }

  async incrementUseCount(id: string): Promise<IInvite | null> {
    return this.model
      .findOneAndUpdate(
        {
          _id: id,
          status: 'active',
          $or: [
            { maxUses: null },
            { maxUses: { $exists: false } },
            { $expr: { $lt: ['$useCount', '$maxUses'] } },
          ],
        },
        { $inc: { useCount: 1 } },
        { new: true },
      )
      .exec()
      .then(async (invite) => {
        if (invite && invite.maxUses && invite.useCount >= invite.maxUses) {
          invite.status = 'exhausted'
          await invite.save()
        }
        return invite
      })
  }

  /**
   * Give back a use that `incrementUseCount` claimed for a sign-up which then failed (a taken
   * username, a lost race on the address). The use is claimed first so two simultaneous sign-ups
   * cannot share a single-use invite; this keeps a failure from burning it. A revoked invite stays
   * revoked: only `exhausted` reopens.
   */
  async releaseUse(id: string): Promise<void> {
    await this.model.updateOne({ _id: id, useCount: { $gt: 0 } }, { $inc: { useCount: -1 } }).exec()
    await this.model
      .updateOne({ _id: id, status: 'exhausted', $expr: { $lt: ['$useCount', '$maxUses'] } }, { $set: { status: 'active' } })
      .exec()
  }

  async revoke(id: string, orgId: string): Promise<IInvite | null> {
    return this.model
      .findOneAndUpdate(
        { _id: id, orgId, status: 'active' },
        { $set: { status: 'revoked' } },
        { new: true },
      )
      .exec()
  }

  validate(invite: IInvite): { valid: boolean; reason?: string } {
    if (invite.status !== 'active') {
      return { valid: false, reason: `Invite is ${invite.status}` }
    }
    if (invite.expiresAt && new Date() > invite.expiresAt) {
      return { valid: false, reason: 'Invite has expired' }
    }
    if (invite.maxUses && invite.useCount >= invite.maxUses) {
      return { valid: false, reason: 'Invite has been fully used' }
    }
    return { valid: true }
  }
}

export const inviteDao = new InviteDaoClass()
