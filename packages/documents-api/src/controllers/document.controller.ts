import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'mimeType', 'size', 'version']

export const documentController = new Elysia({ prefix: '/org/:orgId/documents/files' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name']))
    }
    if (query.workspaceId) filter.workspaceId = query.workspaceId
    if (query.ownerId) filter.ownerId = query.ownerId
    if (query.mimeType) filter.mimeType = query.mimeType
    if (query.relatedEntityType) filter.relatedEntityType = query.relatedEntityType
    if (query.relatedEntityId) filter.relatedEntityId = query.relatedEntityId
    if (query.isArchived !== undefined) filter.isArchived = query.isArchived === 'true'
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.documents.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    return {
      documents: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'documents.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const doc = await r.documents.findOne({ id, orgId } as any)
    if (!doc) return status(404, { message: 'Document not found' })
    return doc
  }, { access: { permission: 'documents.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const doc = await r.documents.create({
      orgId,
      name: body.name,
      workspaceId: body.workspaceId,
      folderId: body.folderId,
      fileId: body.fileId,
      mimeType: body.mimeType,
      size: body.size,
      tags: body.tags || [],
      ownerId: user.id,
      accessLevel: body.accessLevel || 'private',
      sharedWith: [],
      version: 1,
      versions: [{
        version: 1,
        fileId: body.fileId,
        uploadedBy: user.id,
        uploadedAt: new Date(),
        size: body.size,
        notes: body.notes,
      }],
      relatedEntityType: body.relatedEntityType,
      relatedEntityId: body.relatedEntityId,
      isArchived: false,
    } as any)

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'create', entityType: 'Document',
      entityId: doc.id, entityName: body.name,
    }).catch(() => {})

    return doc
  }, {
    access: { permission: 'documents.write' },
    body: t.Object({
      name: t.String({ minLength: 1 }),
      workspaceId: t.String(),
      folderId: t.Optional(t.String()),
      fileId: t.String(),
      mimeType: t.String(),
      size: t.Number({ minimum: 0 }),
      tags: t.Optional(t.Array(t.String())),
      accessLevel: t.Optional(t.String()),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
      notes: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.documents.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Document not found' })

    const updated = await r.documents.update(id, body as any)
    if (!updated) return status(500, { message: 'Failed to update' })

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'Document',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'documents.write' },
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      workspaceId: t.Optional(t.String()),
      folderId: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      accessLevel: t.Optional(t.String()),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
    }),
  })

  // ── DELETE (soft — archive) ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.documents.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Document not found' })

    const updated = await r.documents.update(id, { isArchived: true } as any)
    if (!updated) return status(500, { message: 'Failed to archive' })

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'delete', entityType: 'Document',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'isArchived', oldValue: false, newValue: true }],
    }).catch(() => {})

    return { message: 'Archived' }
  }, { access: { permission: 'documents.write' } })

  // ── SHARE ──
  .post('/:id/share', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.documents.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Document not found' })

    // Check if user is already in sharedWith
    const alreadyShared = existing.sharedWith.some((s: any) => s.userId === body.userId)
    let updatedSharedWith
    if (alreadyShared) {
      // Update existing share permission
      updatedSharedWith = existing.sharedWith.map((s: any) =>
        s.userId === body.userId ? { ...s, permission: body.permission } : s
      )
    } else {
      updatedSharedWith = [...existing.sharedWith, { userId: body.userId, permission: body.permission }]
    }

    const updated = await r.documents.update(id, { sharedWith: updatedSharedWith } as any)
    if (!updated) return status(500, { message: 'Failed to update sharing' })

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'Document',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'sharedWith', oldValue: existing.sharedWith, newValue: updatedSharedWith }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'documents.write' },
    body: t.Object({
      userId: t.String(),
      permission: t.String(),
    }),
  })

  // ── ARCHIVE / UNARCHIVE ──
  .post('/:id/archive', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()

    const existing = await r.documents.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Document not found' })

    const newArchived = !existing.isArchived
    const updated = await r.documents.update(id, { isArchived: newArchived } as any)
    if (!updated) return status(500, { message: 'Failed to toggle archive' })

    createAuditEntry({
      orgId, userId: user.id, module: 'documents', action: 'update', entityType: 'Document',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'isArchived', oldValue: existing.isArchived, newValue: newArchived }],
    }).catch(() => {})

    return updated
  }, { access: { permission: 'documents.write' } })
