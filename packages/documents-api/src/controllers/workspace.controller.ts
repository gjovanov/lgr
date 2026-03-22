import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'ownerId']

export const workspaceController = new Elysia({ prefix: '/org/:orgId/documents/workspaces' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'description']))
    }
    if (query.parentId) filter.parentId = query.parentId
    if (query.ownerId) filter.ownerId = query.ownerId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.documentWorkspaces.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      workspaces: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'documents.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const workspace = await r.documentWorkspaces.findOne({ id, orgId } as any)
    if (!workspace) return status(404, { message: 'Workspace not found' })
    return workspace
  }, { access: { permission: 'documents.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const workspace = await r.documentWorkspaces.create({
      orgId,
      name: body.name,
      description: body.description,
      parentId: body.parentId,
      color: body.color,
      ownerId: user.id,
      memberIds: body.memberIds || [],
      isActive: true,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'create', entityType: 'DocumentWorkspace',
      entityId: workspace.id, entityName: body.name,
    }).catch(() => {})

    return workspace
  }, {
    access: { permission: 'documents.write' },
    body: t.Object({
      name: t.String({ minLength: 1 }),
      description: t.Optional(t.String()),
      parentId: t.Optional(t.String()),
      color: t.Optional(t.String()),
      memberIds: t.Optional(t.Array(t.String())),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.documentWorkspaces.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Workspace not found' })

    const updated = await r.documentWorkspaces.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'DocumentWorkspace',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'documents.write' },
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      description: t.Optional(t.String()),
      parentId: t.Optional(t.String()),
      color: t.Optional(t.String()),
      memberIds: t.Optional(t.Array(t.String())),
      isActive: t.Optional(t.Boolean()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.documentWorkspaces.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Workspace not found' })

    // Check if workspace has documents
    const docsInWorkspace = await r.documents.findAll({ orgId, workspaceId: id } as any, { page: 0, size: 1 })
    if (docsInWorkspace.total > 0) {
      return status(400, { message: 'Cannot delete workspace that contains documents' })
    }

    // Check if workspace has child workspaces
    const childWorkspaces = await r.documentWorkspaces.findAll({ orgId, parentId: id } as any, { page: 0, size: 1 })
    if (childWorkspaces.total > 0) {
      return status(400, { message: 'Cannot delete workspace that has child workspaces' })
    }

    await r.documentWorkspaces.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'delete', entityType: 'DocumentWorkspace',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'documents.manage' } })
