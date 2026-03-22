import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import {
  listPermissionSets,
  getPermissionSet,
  createPermissionSet,
  updatePermissionSet,
  deletePermissionSet,
  computeEffectivePermissions,
  migrateToPermissionSets,
  getPermissionSetUserCounts,
} from 'services/biz/permission-set.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { createAuditEntry } from 'services/biz/audit-log.service'

const ownRecordsSchema = t.Optional(
  t.Object({
    sales: t.Optional(t.Boolean()),
    purchase: t.Optional(t.Boolean()),
    project: t.Optional(t.Boolean()),
    helpdesk: t.Optional(t.Boolean()),
    crm: t.Optional(t.Boolean()),
    payroll: t.Optional(t.Boolean()),
    hr: t.Optional(t.Boolean()),
    documents: t.Optional(t.Boolean()),
    subscriptions: t.Optional(t.Boolean()),
    planning: t.Optional(t.Boolean()),
    fleet: t.Optional(t.Boolean()),
    erp: t.Optional(t.Boolean()),
  }),
)

export const permissionSetController = new Elysia({ prefix: '/org/:orgId/permission-sets' })
  .use(AuthService)
  // GET / — list all permission sets for the org
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
      return status(403, { message: 'Forbidden' })
    }

    const result = await listPermissionSets(orgId)
    const userCounts = await getPermissionSetUserCounts(orgId)

    // Attach userCount to each set
    const sets = result.permissionSets.map((s: any) => ({
      ...s,
      userCount: userCounts[String(s._id)] || 0,
    }))

    return { permissionSets: sets, total: result.total }
  }, { isSignIn: true })

  // GET /effective/:userId — compute effective permissions for a user
  .get('/effective/:userId', async ({ params: { userId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
      return status(403, { message: 'Forbidden' })
    }

    try {
      const result = await computeEffectivePermissions(userId)
      return result
    } catch (e: any) {
      return status(404, { message: e.message })
    }
  }, { isSignIn: true })

  // GET /:id — get one permission set
  .get('/:id', async ({ params: { id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
      return status(403, { message: 'Forbidden' })
    }

    const set = await getPermissionSet(id)
    if (!set) return status(404, { message: 'Permission set not found' })

    return { permissionSet: set }
  }, { isSignIn: true })

  // POST / — create a new permission set
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
        return status(403, { message: 'Forbidden' })
      }

      const created = await createPermissionSet(orgId, body)

      createAuditEntry({
        orgId,
        userId: user.id,
        action: 'create',
        module: 'admin',
        entityType: 'permission_set',
        entityId: String(created._id),
        entityName: body.name,
      })

      return { permissionSet: created }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        description: t.Optional(t.String()),
        permissions: t.Array(t.String()),
        ownRecordsOnly: ownRecordsSchema,
        isDefault: t.Optional(t.Boolean()),
        isAdmin: t.Optional(t.Boolean()),
      }),
    },
  )

  // PUT /:id — update a permission set
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
        return status(403, { message: 'Forbidden' })
      }

      const updated = await updatePermissionSet(id, body)
      if (!updated) return status(404, { message: 'Permission set not found' })

      createAuditEntry({
        orgId,
        userId: user.id,
        action: 'update',
        module: 'admin',
        entityType: 'permission_set',
        entityId: id,
        entityName: updated.name,
      })

      return { permissionSet: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String({ minLength: 1 })),
        description: t.Optional(t.String()),
        permissions: t.Optional(t.Array(t.String())),
        ownRecordsOnly: ownRecordsSchema,
        isDefault: t.Optional(t.Boolean()),
        isAdmin: t.Optional(t.Boolean()),
      }),
    },
  )

  // DELETE /:id — delete a permission set
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
      return status(403, { message: 'Forbidden' })
    }

    const existing = await getPermissionSet(id)
    const result = await deletePermissionSet(id)
    if (!result.success) {
      return status(400, { message: result.reason })
    }

    createAuditEntry({
      orgId,
      userId: user.id,
      action: 'delete',
      module: 'admin',
      entityType: 'permission_set',
      entityId: id,
      entityName: existing?.name,
    })

    return { message: 'Permission set deleted' }
  }, { isSignIn: true })

  // POST /migrate — migrate from old roles to permission sets
  .post('/migrate', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!user.permissions?.includes('admin.settings') && user.role !== 'admin') {
      return status(403, { message: 'Forbidden' })
    }

    // Ensure default sets exist first
    await seedDefaultPermissionSets(orgId)

    const result = await migrateToPermissionSets(orgId)

    createAuditEntry({
      orgId,
      userId: user.id,
      action: 'migrate',
      module: 'admin',
      entityType: 'permission_set',
      entityId: orgId,
      entityName: 'Role migration',
    })

    return { message: 'Migration complete', ...result }
  }, { isSignIn: true })
