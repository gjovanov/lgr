import { Elysia, t } from 'elysia'
import { RoleRefusal, assertAssignable, defaultRoleOf } from 'services/biz/access/role.service'
import { Role, type IInvite } from 'db/models'
import { roleDisplay } from 'config/access'
import { can } from 'services/biz/access/evaluate'
import { AuthService } from '../auth/auth.service.js'
import { inviteDao } from 'services/dao/invite.dao'
import { orgDao } from 'services/dao/org.dao'
import { userDao } from 'services/dao/user.dao'
import { Identity, Invite } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { IdentityError } from 'services/biz/identity/identity.service'
import { joinOrgByInvite } from 'services/biz/identity/account.service'
import { inviteUrl, isEmailAddress, mailInvite } from 'services/biz/invite-email.service'
import { BEARER_REQUIRED, NOT_A_PERSON, bearerPresent, callerOf, enterOrg } from '../auth/session-answer.js'

/** The role an invitation gives, for display (`roleDisplay`); one from before FR-27 P3-5 names only its legacy key. */
async function inviteRoleDisplay(invite: Pick<IInvite, 'orgId' | 'assignRoleId' | 'assignRole'>): Promise<string> {
  const role = invite.assignRoleId
    ? await Role.findOne({ _id: invite.assignRoleId, orgId: invite.orgId }, { name: 1, isBuiltin: 1, templateKey: 1 }).lean().exec()
    : null
  return role ? roleDisplay(role) : invite.assignRole ?? ''
}

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
        // FR-27 P3-5: the role it gives, for display (a built-in by its key, any other by its name); an invitation
        // from before names only its legacy key.
        role: await inviteRoleDisplay(invite),
      }
    },
  )
  /**
   * Accept an invitation as the signed-in person (multi-org Phase 4): a membership in the invite's
   * org with the invite's role, then a session in it. The invite must still be valid, a pinned one
   * must name the person's address, and rule 3 holds (a credential the person owns). The invite is
   * consumed before the membership exists, so a single-use one cannot admit two. ⚠ Bearer only.
   */
  .post('/invite/:code/accept', async ({ params: { code }, jwt, user, person, headers, cookie, status }) => {
    if (!bearerPresent(headers.authorization)) return status(401, BEARER_REQUIRED)
    const caller = callerOf(user, person)
    if (!caller?.iid) return status(403, NOT_A_PERSON)
    try {
      const { member } = await joinOrgByInvite(caller.iid, code)
      const identity = await Identity.findById(caller.iid, { tokenVersion: 1 }).exec()
      return await enterOrg({ jwt, cookie }, member, identity!, caller.exp, 'join')
    } catch (err) {
      if (err instanceof IdentityError) return status(err.status, { message: err.message, code: err.code })
      throw err
    }
  })
  // Admin: list org invites
  .get(
    '/org/:orgId/invite',
    async ({ params: { orgId }, user, status, query }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'invites.manage')) return status(403, { message: 'Admin only' })

      const filter: Record<string, any> = { orgId }
      // FR-27 P3-7: an invite's `legacyArchive` (migration 0017) is kept for a hand restore, never sent.
      const result = await paginateQuery(Invite, filter, query, { select: '-legacyArchive' })
      return { invites: result.items, ...result }
    },
    { isSignIn: true },
  )
  // Admin: create invite
  .post(
    '/org/:orgId/invite',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'invites.manage')) return status(403, { message: 'Admin only' })

      // #510: an address that is sent must be one. A blank one used to make the invite an open link
      // with unlimited uses, which anyone holding it could join through.
      const targetEmail = body.targetEmail === undefined ? undefined : body.targetEmail.trim()
      if (targetEmail !== undefined && !isEmailAddress(targetEmail)) {
        return status(422, { code: 'invalid_email', message: 'Enter the address the invitation is for' })
      }
      // FR-27 P3-3 (#529): an invitation names a role (`assignRoleId`), one the admin may give (FR-27.8). The legacy
      // `assignRole` is refused, never dropped: a caller that named one and got 200 would believe the invitee gets it.
      if (body.assignRole !== undefined) {
        return status(422, { code: 'legacy_role_field', message: 'Name the role by its id (assignRoleId): a legacy role (assignRole) is no longer accepted.' })
      }
      // Naming none is the org's default role (FR-27.3) when this admin may give it, else the built-in Member.
      let assignRoleId = body.assignRoleId
      if (!assignRoleId) {
        const fallback = await defaultRoleOf(orgId)
        if (fallback) assignRoleId = await assertAssignable(user as any, orgId, fallback).then(() => fallback, () => undefined)
      }
      if (!assignRoleId) {
        const member: any = await Role.findOne({ orgId, isBuiltin: true, templateKey: 'member' }, { _id: 1 }).lean().exec()
        if (!member) return status(422, { code: 'no_role', message: 'This organization has no role to invite with.' })
        assignRoleId = String(member._id)
      }
      try {
        await assertAssignable(user as any, orgId, assignRoleId)
      } catch (e) {
        if (e instanceof RoleRefusal) return status(e.status, e.body)
        throw e
      }
      // FR-27 P3-5 (#529): the role alone, by id. Its legacy key (`assignRole`) is no longer written.
      const invite = await inviteDao.createInvite({
        orgId,
        inviterId: user.id,
        targetEmail,
        maxUses: body.maxUses,
        assignRoleId,
        expiresInHours: body.expiresInHours,
      })

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'admin', entityType: 'invite', entityId: String(invite._id), entityName: targetEmail || invite.code })

      // #510: an invite that names an address is mailed to it. The admin is told whether it went out,
      // and gets the link either way, to share it themselves.
      const org = targetEmail ? await orgDao.findById(orgId) : null
      const email = org ? await mailInvite(invite, org as any, `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || user.email || 'LGR') : null

      return { invite: invite.toJSON(), link: inviteUrl(invite.code), ...(email ? { email } : {}) }
    },
    {
      isSignIn: true,
      body: t.Object({
        targetEmail: t.Optional(t.String()),
        maxUses: t.Optional(t.Number()),
        // Declared only to be refused (422 `legacy_role_field`): a schema drops what it does not name.
        assignRole: t.Optional(t.Unknown()),
        assignRoleId: t.Optional(t.String()),
        expiresInHours: t.Optional(t.Number()),
      }),
    },
  )
  // Admin: revoke invite
  .delete(
    '/org/:orgId/invite/:inviteId',
    async ({ params: { orgId, inviteId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'invites.manage')) return status(403, { message: 'Admin only' })

      const invite = await inviteDao.revoke(inviteId, orgId)
      if (!invite) return status(404, { message: 'Invite not found or already revoked' })

      createAuditEntry({ orgId, userId: user.id, action: 'revoke', module: 'admin', entityType: 'invite', entityId: inviteId, entityName: invite.code })

      return { invite: invite.toJSON() }
    },
    { isSignIn: true },
  )
