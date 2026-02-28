import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { inviteDao } from 'services/dao/invite.dao'
import { orgDao } from 'services/dao/org.dao'
import { userDao } from 'services/dao/user.dao'
import { Invite } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const inviteController = new Elysia()
  .use(AuthService)
  // Public: get invite info by code
  .get(
    '/invite/:code',
    async ({ params: { code }, status }) => {
      const invite = await inviteDao.findByCode(code)
      if (!invite) return status(404, { message: 'Invite not found' })

      const org = await orgDao.findById(invite.orgId)
      if (!org) return status(404, { message: 'Organization not found' })

      const inviter = await userDao.findById(invite.inviterId)
      const validation = inviteDao.validate(invite)

      return {
        code: invite.code,
        orgName: org.name,
        orgSlug: org.slug,
        inviterName: inviter
          ? `${inviter.firstName} ${inviter.lastName}`
          : 'Unknown',
        isValid: validation.valid,
        status: invite.status,
        targetEmail: invite.targetEmail || null,
        assignRole: invite.assignRole,
      }
    },
  )
  // Admin: list org invites
  .get(
    '/org/:orgId/invite',
    async ({ params: { orgId }, user, status, query }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const filter: Record<string, any> = { orgId }
      const result = await paginateQuery(Invite, filter, query)
      return { invites: result.items, ...result }
    },
    { isSignIn: true },
  )
  // Admin: create invite
  .post(
    '/org/:orgId/invite',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const invite = await inviteDao.createInvite({
        orgId,
        inviterId: user.id,
        targetEmail: body.targetEmail,
        maxUses: body.maxUses,
        assignRole: body.assignRole,
        expiresInHours: body.expiresInHours,
      })

      return invite
    },
    {
      isSignIn: true,
      body: t.Object({
        targetEmail: t.Optional(t.String()),
        maxUses: t.Optional(t.Number()),
        assignRole: t.Optional(t.String()),
        expiresInHours: t.Optional(t.Number()),
      }),
    },
  )
  // Admin: revoke invite
  .delete(
    '/org/:orgId/invite/:inviteId',
    async ({ params: { orgId, inviteId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const invite = await inviteDao.revoke(inviteId, orgId)
      if (!invite) return status(404, { message: 'Invite not found or already revoked' })

      return invite
    },
    { isSignIn: true },
  )
