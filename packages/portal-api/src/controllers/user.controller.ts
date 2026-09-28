import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { userDao } from 'services/dao/user.dao'
import { User, PermissionSet } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { DEFAULT_ROLE_PERMISSIONS, ROLES } from 'config/constants'
import { createAuditEntry } from 'services/biz/audit-log.service'

import { allocateOperatorCode } from 'services/biz/sequence.service'

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
    return { users: result.items, ...result }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const hashedPassword = await Bun.password.hash(body.password)
      const role = body.role || 'member'

      // Auto-assign operator code (4-digit, SUPTO requirement)
      const operatorCode = await allocateOperatorCode(orgId)

      const created = await userDao.create({
        ...body,
        password: hashedPassword,
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

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'admin', entityType: 'user', entityId: String(created._id), entityName: `${body.firstName} ${body.lastName}` })

      return { user: created.toJSON() }
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
  .get('/:userId', async ({ params: { userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const found = await userDao.findByIdSafe(userId)
    if (!found) return status(404, { message: 'User not found' })

    return { user: found }
  }, { isSignIn: true })
  .put(
    '/:userId',
    async ({ params: { orgId, userId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const existing = await User.findById(userId).exec()
      if (!existing) return status(404, { message: 'User not found' })

      const updateData: Record<string, unknown> = { ...body }
      if (body.password) {
        updateData.password = await Bun.password.hash(body.password)
      }

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

      const updated = await userDao.update(userId, updateData)
      if (!updated) return status(404, { message: 'User not found' })

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

    const existing = await userDao.findByIdSafe(userId)
    if (!existing) return status(404, { message: 'User not found' })

    // Soft delete: set isActive=false and deactivatedAt
    await userDao.update(userId, { isActive: false, deactivatedAt: new Date() })

    createAuditEntry({ orgId, userId: user.id, action: 'deactivate', module: 'admin', entityType: 'user', entityId: userId, entityName: `${existing.firstName} ${existing.lastName}` })

    return { message: 'User deactivated' }
  }, { isSignIn: true })
