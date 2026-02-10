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
    page = 1,
    pageSize = 50,
  ): Promise<PaginatedResult<IInvite>> {
    return this.findAll({ orgId } as any, page, pageSize)
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
