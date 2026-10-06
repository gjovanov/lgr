import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { userDao } from 'services/dao/user.dao'
import { User, PermissionSet } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { DEFAULT_ROLE_PERMISSIONS, ROLES } from 'config/constants'
import { createAuditEntry } from 'services/biz/audit-log.service'

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

/** An identity refusal as the HTTP answer: its status, and a code the UI can act on. */
const refused = (err: unknown) =>
  err instanceof IdentityError ? { status: err.status, body: { code: err.code, message: err.message } } : null

/**
 * Derived from `ROLES` rather than re-listed, so a role can never be accepted here without a
 * `DEFAULT_ROLE_PERMISSIONS` entry to go with it — which is exactly how `hr_manager` and
 * `sales` came to be assignable while granting no permissions.
 */
const roleValues = ROLES.map(r => t.Literal(r))

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
    const result = await paginateQuery(User, filter, query, { select: '-password' })
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
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      // ⚠ Multi-org: an admin never attaches a person who already has an account (here or, before
      // the migration, as a user anywhere). Whoever could then set their password would have every
      // org they work in. They are invited instead, and join by proving it is them.
      if (await emailInUse(body.email)) {
        const r = refused(new IdentityError('identity_exists'))!
        return status(r.status, r.body)
      }

      const hashedPassword = await Bun.password.hash(body.password)
      const role = body.role || 'member'

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
          ...body,
          email: normalizeEmail(body.email),
          password: hashedPassword, // the legacy copy, kept in step until it is retired
          identityId: identity._id,
          role,
          operatorCode,
          orgId: orgId as unknown as import('mongoose').Types.ObjectId,
          isActive: true,
          permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
          roleHistory: [{
            role,
            startDate: new Date(),
            assignedBy: user.id,
            assignedAt: new Date(),
          }],
        })
      } catch (err) {
        await discardIdentity(identity._id)
        throw err
      }

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'admin', entityType: 'user', entityId: String(created._id), entityName: `${body.firstName} ${body.lastName}` })

      // Never echo the hash back — the same rule as the list (FR-11.3) and the `/:userId` routes.
      const { password: _hash, ...safe } = created.toJSON() as Record<string, unknown>
      return { user: safe }
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.String({ format: 'email' }),
        username: t.String({ minLength: 3 }),
        password: t.String({ minLength: 6 }),
        firstName: t.String({ minLength: 1 }),
        middleName: t.Optional(t.String()),
        lastName: t.String({ minLength: 1 }),
        position: t.Optional(t.String()),
        role: t.Optional(t.Union(roleValues)),
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
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const existing = await userDao.findInOrg(userId, orgId)
      if (!existing) return status(404, { message: 'User not found' })

      const updateData: Record<string, unknown> = { ...body }
      delete updateData.password // set below, from the identity edit's one hash

      // Validate permissionSetIds if provided
      if (body.permissionSetIds && body.permissionSetIds.length > 0) {
        const validSets = await PermissionSet.find({
          _id: { $in: body.permissionSetIds },
          orgId,
        }).lean().exec()
        if (validSets.length !== body.permissionSetIds.length) {
          return status(400, { message: 'One or more permission set IDs are invalid' })
        }
      }

      // ⚠ An admin may not change their OWN role. Now that the Users screen exposes the role
      // select (it was rendered `disabled`, so this was unreachable), the single-admin org is
      // one save away from having no admin at all — and no UI path back, since every route
      // that could restore it is itself admin-only. Demotions go through another admin.
      if (body.role && body.role !== existing.role && String(existing._id) === String(user.id)) {
        return status(403, { message: 'You cannot change your own role' })
      }

      // Track role changes in roleHistory (Appendix 29 requirement)
      if (body.role && body.role !== existing.role) {
        const now = new Date()
        const history = [...(existing.roleHistory || [])]

        // Close the current role's period
        const lastEntry = history.find(h => !h.endDate)
        if (lastEntry) {
          lastEntry.endDate = now
        }

        // Open new role period
        history.push({
          role: body.role,
          startDate: now,
          assignedBy: user.id as any,
          assignedAt: now,
        })
        updateData.roleHistory = history

        // Update permissions to match new role
        updateData.permissions = DEFAULT_ROLE_PERMISSIONS[body.role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || existing.permissions
      }

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

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'admin', entityType: 'user', entityId: userId, entityName: `${updated.firstName} ${updated.lastName}` })

      return { user: updated.toJSON() }
    },
    {
      isSignIn: true,
      body: t.Object({
        email: t.Optional(t.String({ format: 'email' })),
        username: t.Optional(t.String({ minLength: 3 })),
        password: t.Optional(t.String({ minLength: 6 })),
        firstName: t.Optional(t.String()),
        middleName: t.Optional(t.String()),
        lastName: t.Optional(t.String()),
        position: t.Optional(t.String()),
        role: t.Optional(t.Union(roleValues)),
        isActive: t.Optional(t.Boolean()),
        permissions: t.Optional(t.Array(t.String())),
        permissionSetIds: t.Optional(t.Array(t.String())),
      }),
    },
  )
  // Soft-delete: deactivate instead of hard delete (Appendix 29 compliance)
  .delete('/:userId', async ({ params: { orgId, userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const existing = await userDao.findInOrg(userId, orgId)
    if (!existing) return status(404, { message: 'User not found' })

    // Soft delete: set isActive=false and deactivatedAt
    await userDao.updateInOrg(userId, orgId, { isActive: false, deactivatedAt: new Date() })

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'admin', entityType: 'user', entityId: userId, entityName: `${existing.firstName} ${existing.lastName}` })

    return { message: 'User deactivated' }
  }, { isSignIn: true })
