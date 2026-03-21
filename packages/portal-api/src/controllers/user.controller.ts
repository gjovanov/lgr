import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { userDao } from 'services/dao/user.dao'
import { User } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { createAuditEntry } from 'services/biz/audit-log.service'

import { Sequence } from 'db/models'

/** Atomic operator code generation using MongoDB $inc (H2: race-condition safe) */
async function getNextOperatorCode(orgId: string): Promise<string> {
  const doc = await Sequence.findOneAndUpdate(
    { orgId, prefix: 'OPERATOR', year: 0 },
    { $inc: { lastNumber: 1 } },
    { upsert: true, returnDocument: 'after' },
  ).exec()
  return String(doc!.lastNumber).padStart(4, '0')
}

const roleValues = [
  t.Literal('admin'),
  t.Literal('manager'),
  t.Literal('accountant'),
  t.Literal('hr_manager'),
  t.Literal('warehouse_manager'),
  t.Literal('sales'),
  t.Literal('member'),
  t.Literal('nra_auditor'),
] as const

export const userController = new Elysia({ prefix: '/org/:orgId/user' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.includeDeactivated !== 'true') {
      filter.isActive = true
    }
    const result = await paginateQuery(User, filter, query)
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
      const operatorCode = await getNextOperatorCode(orgId)

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
