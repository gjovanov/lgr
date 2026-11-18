import { Elysia, t } from 'elysia'
import { can } from 'services/biz/access/evaluate'
import { AuthService } from '../auth/auth.service.js'
import { publicUser, userDao, USER_PUBLIC_PROJECTION } from 'services/dao/user.dao'
import { User } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { ROLES } from 'config/constants'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { RoleRefusal, assertAssignable, assertNotLastAdministrator, assignRole, giveStartingRole, namedRoleId, startingRoleOf } from 'services/biz/access/role.service'

import { allocateOperatorCode } from 'services/biz/sequence.service'
import {
  IdentityError,
  adminActivated,
  applyAdminIdentityEdit,
  createIdentity,
  discardIdentity,
  emailInUse,
  normalizeEmail,
} from 'services/biz/identity/identity.service'
import { endSessionsOf, forgetMembership } from 'services/biz/identity/session.service'

/** An identity refusal as the HTTP answer: its status, and a code the UI can act on. */
const refused = (err: unknown) =>
  err instanceof IdentityError ? { status: err.status, body: { code: err.code, message: err.message } } : null

/**
 * Derived from `ROLES` rather than re-listed, so a role can never be accepted here without a
 * `DEFAULT_ROLE_PERMISSIONS` entry to go with it — which is exactly how `hr_manager` and
 * `sales` came to be assignable while granting no permissions.
 */
const roleValues = ROLES.map(r => t.Literal(r))

/**
 * FR-27.3 (#529): a body names the person's role by `roleId`, or by `roleKey` (a built-in role's template key, the same
 * in every org: `role.service#namedRoleId` checks it, 422 `unknown_role_key`). Free text in the schema so that an
 * unknown key gets that code, not the schema's bare 422.
 */
const roleKeyField = t.Optional(t.String({ minLength: 1, maxLength: 64 }))

/** FR-27 P3-5: the legacy sets and permissions cannot be written any more; refused, never dropped. */
const LEGACY_FIELDS = { code: 'legacy_role_field', message: 'Give the person a role (roleId): permission sets and permissions are no longer written.' }

export const userController = new Elysia({ prefix: '/org/:orgId/user' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.includeDeactivated !== 'true') {
      filter.isActive = true
    }
    // FR-11.3 (#21) — security rider. This list had NO projection and `password` has no
    // `select: false`, so every caller of this endpoint was receiving bcrypt hashes. The
    // digest's recipient picker is what put a browser in front of it. Nothing reads
    // `password` from this response (verified), so the projection is unconditional.
    // S-14: the provider tokens an OAuth link has room for are excluded with it.
    const result = await paginateQuery(User, filter, query, { select: USER_PUBLIC_PROJECTION })
    // Multi-org (rule 2): who also works in another org. Their password, email and name are theirs
    // alone, and the admin screen disables those fields for them (never which other org it is).
    const people = result.items.map((u: any) => u.identityId).filter(Boolean)
    const elsewhere = people.length
      ? await User.distinct('identityId', { identityId: { $in: people }, orgId: { $ne: orgId }, isActive: true }).exec()
      : []
    const shared = new Set(elsewhere.map(String))
    const users = result.items.map((u: any) => ({ ...u, multiOrg: !!u.identityId && shared.has(String(u.identityId)) }))
    return { ...result, users, items: users }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'users.edit')) return status(403, { message: 'Admin only' })

      // ⚠ Multi-org: an admin never attaches a person who already has an account (here or, before
      // the migration, as a user anywhere). Whoever could then set their password would have every
      // org they work in. They are invited instead, and join by proving it is them.
      if (await emailInUse(body.email)) {
        const r = refused(new IdentityError('identity_exists'))!
        return status(r.status, r.body)
      }
      // FR-27.3: a role named here (`roleId`, or `roleKey`: the built-in role of that key) must be one the admin may
      // give, before anything is created. A legacy `role` key is still the built-in role of that key, logged (#529).
      const { roleId: _roleId, roleKey: _roleKey, role: _legacyKey, ...fields } = body
      let roleId: string | undefined
      try {
        roleId = await namedRoleId(orgId, body, 'POST /user')
        if (roleId) await assertAssignable(user as any, orgId, roleId)
      } catch (e) {
        if (e instanceof RoleRefusal) return status(e.status, e.body)
        throw e
      }

      const hashedPassword = await Bun.password.hash(body.password)

      let identity
      try {
        identity = await createIdentity(
          {
            email: body.email,
            password: hashedPassword,
            passwordSetBy: 'admin',
            passwordSetByOrgId: orgId,
            firstName: body.firstName,
            middleName: body.middleName,
            lastName: body.lastName,
            isActive: true,
          },
          'identity_exists',
        )
      } catch (err) {
        const r = refused(err)
        if (r) return status(r.status, r.body)
        throw err
      }

      let created
      try {
        // Auto-assign operator code (4-digit, SUPTO requirement)
        const operatorCode = await allocateOperatorCode(orgId)

        created = await userDao.create({
          ...fields,
          email: normalizeEmail(body.email),
          password: hashedPassword, // the legacy copy, kept in step until it is retired
          identityId: identity._id,
          operatorCode,
          orgId: orgId as unknown as import('mongoose').Types.ObjectId,
          isActive: true,
          // FR-27 P3-5 (#529): no legacy role, sets or permissions. The role below opens the role history.
        })
      } catch (err) {
        await discardIdentity(identity._id)
        throw err
      }

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'admin', entityType: 'user', entityId: String(created._id), entityName: `${body.firstName} ${body.lastName}` })
      if (roleId) await assignRole(user as any, orgId, String(created._id), roleId)
      else await giveStartingRole(orgId, created._id, await startingRoleOf(orgId, {}), user.id)

      // Never echo the hash back — the same rule as the list (FR-11.3) and the `/:userId` routes.
      return { user: publicUser(created.toJSON() as Record<string, any>) }
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        // S-09: the rule a password change and a reset already apply (12; was 6 here).
        password: t.String({ minLength: 12, maxLength: 256 }),
        firstName: t.String({ minLength: 1 }),
        middleName: t.Optional(t.String()),
        lastName: t.String({ minLength: 1 }),
        position: t.Optional(t.String()),
        // FR-27 P3-5: a legacy key names the built-in role of that key; it is not written. Logged; the next release
        // refuses it (422 `legacy_role_field`): send `roleKey`.
        role: t.Optional(t.Union(roleValues)),
        // FR-27.3: the person's role, by id or by its built-in template key; one of the two.
        roleId: t.Optional(t.String()),
        roleKey: roleKeyField,
      }),
    },
  )
  // ⚠ S-21: every `/:userId` lookup below carries `orgId`. The tenant guard proves only that the
  // caller belongs to `:orgId` — their own org — so a lookup by `_id` alone let an admin of any
  // org (and anyone may register one) read, rewrite and deactivate another org's users.
  .get('/:userId', async ({ params: { orgId, userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const found = await userDao.findInOrg(userId, orgId)
    if (!found) return status(404, { message: 'User not found' })

    return { user: found }
  }, { isSignIn: true })
  .put(
    '/:userId',
    async ({ params: { orgId, userId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'users.edit')) return status(403, { message: 'Admin only' })

      const existing = await userDao.findInOrg(userId, orgId)
      if (!existing) return status(404, { message: 'User not found' })

      const updateData: Record<string, unknown> = { ...body }
      delete updateData.password // set below, from the identity edit's one hash
      // FR-27 P3-5 (#529): nothing of the legacy model is written onto a person.
      delete updateData.role
      delete updateData.roleId
      delete updateData.roleKey
      delete updateData.permissions
      delete updateData.permissionSetIds

      if (body.permissions !== undefined || body.permissionSetIds !== undefined) return status(422, LEGACY_FIELDS)
      // FR-27.3: the person's one role, by `roleId` or `roleKey` (a legacy `role` key is still the built-in role of
      // that key, logged, #529). role.service holds it to FR-27.8 (not your own, nothing beyond your own, the
      // Administrator's only an Administrator's, never the last Administrator's).
      try {
        const roleId = await namedRoleId(orgId, body, 'PUT /user/:userId')
        if (roleId) await assignRole(user as any, orgId, userId, roleId)
      } catch (e) {
        if (e instanceof RoleRefusal) return status(e.status, e.body)
        throw e
      }
      // The Users form's Active switch, turned off or on.
      const switchedOff = body.isActive === false && existing.isActive !== false
      if (switchedOff) {
        try {
          await assertNotLastAdministrator(orgId, userId)
        } catch (e) {
          if (e instanceof RoleRefusal) return status(e.status, e.body)
          throw e
        }
        // ⚠ Switched off is deactivated, and says when, as the DELETE below does. Without the date the membership
        // read as one still waiting for its first activation, which is the person's own to finish.
        updateData.deactivatedAt = new Date()
      }
      // Switched on again: the date goes, so the next switching off is told from this one.
      if (body.isActive === true && existing.isActive === false) updateData.deactivatedAt = null

      // ⚠ An admin may not change their OWN role (`assignRole` refuses it, `own_role`): the single-admin org would be
      // one save away from having no admin at all. The role history (Appendix 29) is `assignRole`'s.

      // The person's own fields last, once every check above has passed: they may live on an
      // identity this org does not own (refused while the person is active in another org).
      try {
        const applied = await applyAdminIdentityEdit(existing, orgId, {
          password: body.password,
          email: body.email,
          firstName: body.firstName,
          middleName: body.middleName,
          lastName: body.lastName,
        })
        if (applied.passwordHash) updateData.password = applied.passwordHash
        if (existing.identityId) {
          // A linked membership carries the identity's (normalised) address, never a re-cased one.
          delete updateData.email
          if (applied.email) updateData.email = applied.email
        }
      } catch (err) {
        const r = refused(err)
        if (r) return status(r.status, r.body)
        throw err
      }

      const updated = await userDao.updateInOrg(userId, orgId, updateData)
      if (!updated) return status(404, { message: 'User not found' })
      if (body.isActive === true && existing.isActive === false) await adminActivated(existing, orgId)
      // They may do nothing here any more: the sessions they hold end. A change of role is live (FR-27.5).
      if (switchedOff) await endSessionsOf(existing.identityId)
      // And this membership's own session, person or none: read afresh on its next request here.
      if (body.isActive !== undefined) forgetMembership(userId)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'admin', entityType: 'user', entityId: userId, entityName: `${updated.firstName} ${updated.lastName}` })

      return { user: updated.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.Optional(t.String({ format: 'email' })),
        username: t.Optional(t.String({ minLength: 3 })),
        password: t.Optional(t.String({ minLength: 12, maxLength: 256 })), // S-09
        firstName: t.Optional(t.String()),
        middleName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        position: t.Optional(t.String()),
        // FR-27 P3-5: a legacy key names the built-in role of that key; it is not written. Logged; the next release
        // refuses it (422 `legacy_role_field`): send `roleKey`.
        role: t.Optional(t.Union(roleValues)),
        isActive: t.Optional(t.Boolean()),
        // FR-27 P3-5: declared only to be refused (422 `legacy_role_field`): a schema drops what it does not name.
        permissions: t.Optional(t.Array(t.String())),
        permissionSetIds: t.Optional(t.Array(t.String())),
        roleId: t.Optional(t.String()),
        roleKey: roleKeyField,
      }),
    },
  )
  // Soft-delete: deactivate instead of hard delete (Appendix 29 compliance)
  .delete('/:userId', async ({ params: { orgId, userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!can(user, 'users.edit')) return status(403, { message: 'Admin only' })

    const existing = await userDao.findInOrg(userId, orgId)
    if (!existing) return status(404, { message: 'User not found' })
    try {
      await assertNotLastAdministrator(orgId, userId)
    } catch (e) {
      if (e instanceof RoleRefusal) return status(e.status, e.body)
      throw e
    }

    // Soft delete: set isActive=false and deactivatedAt
    await userDao.updateInOrg(userId, orgId, { isActive: false, deactivatedAt: new Date() })
    // The sessions the person holds end with it, as on a change of what they may do (FR-26.9.4).
    if (existing.isActive !== false) await endSessionsOf(existing.identityId)
    // And this membership's own session, person or none: read afresh on its next request here.
    forgetMembership(userId)

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'admin', entityType: 'user', entityId: userId, entityName: `${existing.firstName} ${existing.lastName}` })

    return { message: 'User deactivated' }
  }, { isSignIn: true })
