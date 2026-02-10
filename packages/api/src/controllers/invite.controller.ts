import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { inviteDao } from 'services/dao/invite.dao'
import { orgDao } from 'services/dao/org.dao'
import { userDao } from 'services/dao/user.dao'

export const inviteController = new Elysia()
  .use(AuthService)
  // Public: get invite info by code
  .get(
    '/invite/:code',
    async ({ params: { code }, error }) => {
      const invite = await inviteDao.findByCode(code)
      if (!invite) return error(404, { message: 'Invite not found' })

      const org = await orgDao.findById(invite.orgId)
      if (!org) return error(404, { message: 'Organization not found' })

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
    async ({ params: { orgId }, user, error, query }) => {
      if (!user) return error(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return error(403, { message: 'Admin only' })

      const page = Number(query.page) || 1
      const pageSize = Number(query.pageSize) || 50
      const result = await inviteDao.listByOrg(orgId, page, pageSize)

      return {
        invites: result.data,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        totalPages: result.totalPages,
      }
    },
    { isSignIn: true },
  )
  // Admin: create invite
  .post(
    '/org/:orgId/invite',
    async ({ params: { orgId }, body, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return error(403, { message: 'Admin only' })

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
    async ({ params: { orgId, inviteId }, user, error }) => {
      if (!user) return error(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return error(403, { message: 'Admin only' })

      const invite = await inviteDao.revoke(inviteId, orgId)
      if (!invite) return error(404, { message: 'Invite not found or already revoked' })

      return invite
    },
    { isSignIn: true },
  )
