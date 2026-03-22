import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

import { upsertTags } from 'services/biz/tag.service'

const ALLOWED_SORT_FIELDS = ['createdAt', 'name', 'version', 'accessLevel', 'isPublished']

export const knowledgeController = new Elysia({ prefix: '/org/:orgId/helpdesk/knowledge' })
  .use(AppAuthService)

  // ── LIST ──
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      Object.assign(filter, buildSearchFilter(query.search as string, ['name', 'content']))
    }
    if (query.parentId) filter.parentId = query.parentId
    if (query.authorId) filter.authorId = query.authorId
    if (query.accessLevel) filter.accessLevel = query.accessLevel
    if (query.isPublished !== undefined) {
      filter.isPublished = query.isPublished === 'true'
    }
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Math.min(Number(query.size), 100) : 10
    const sortBy = ALLOWED_SORT_FIELDS.includes(query.sortBy as string) ? (query.sortBy as string) : 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.knowledgeArticles.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Batch lookup authors
    const userIds = new Set<string>()
    for (const item of result.items) {
      if (item.authorId) userIds.add(item.authorId as any)
    }
    const users = userIds.size > 0
      ? await r.users.findMany({ id: { $in: [...userIds] } } as any)
      : []
    const userMap = new Map(users.map((u: any) => [u.id, u]))

    return {
      articles: result.items.map((article: any) => ({
        ...article,
        author: userMap.get(article.authorId) || null,
      })),
      total: result.total,
      page: result.page,
      pageSize: result.size,
    }
  }, { access: { permission: 'knowledge.read' } })

  // ── GET ONE ──
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const article = await r.knowledgeArticles.findOne({ id, orgId } as any)
    if (!article) return status(404, { message: 'Article not found' })

    const author = article.authorId ? await r.users.findById(article.authorId as any) : null

    return { ...article, author }
  }, { access: { permission: 'knowledge.read' } })

  // ── CREATE ──
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    const r = getRepos()

    const article = await r.knowledgeArticles.create({
      orgId,
      name: body.name,
      content: body.content || '',
      parentId: body.parentId,
      authorId: user.id,
      lastEditorId: user.id,
      accessLevel: body.accessLevel || 'internal',
      sharedWith: [],
      tags: body.tags,
      isFavorite: false,
      version: 1,
      versions: [],
      isPublished: false,
      relatedEntityType: body.relatedEntityType,
      relatedEntityId: body.relatedEntityId,
    } as any)

    await upsertTags(orgId, 'knowledge', body.tags)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'create', entityType: 'KnowledgeArticle',
      entityId: article.id, entityName: body.name,
    }).catch(() => {})

    return article
  }, {
    access: { permission: 'knowledge.write' },
    body: t.Object({
      name: t.String({ minLength: 1 }),
      content: t.Optional(t.String()),
      parentId: t.Optional(t.String()),
      accessLevel: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
    }),
  })

  // ── UPDATE ──
  .put('/:id', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()

    const existing = await r.knowledgeArticles.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Article not found' })

    const updates: any = { ...body, lastEditorId: user.id }

    // If content changed, push old content to versions[] and increment version
    if (body.content !== undefined && body.content !== existing.content) {
      const oldVersion = {
        content: existing.content,
        editorId: existing.lastEditorId,
        date: existing.updatedAt || existing.createdAt,
      }
      updates.versions = [...(existing.versions || []), oldVersion]
      updates.version = (existing.version || 1) + 1
    }

    const updated = await r.knowledgeArticles.update(id, updates)
    if (!updated) return status(500, { message: 'Failed to update' })

    if (body.tags) await upsertTags(orgId, 'knowledge', body.tags)

    const changes = diffChanges(existing, updated)
    if (changes.length > 0) {
      createAuditEntry({
        orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'KnowledgeArticle',
        entityId: id, entityName: existing.name, changes,
      }).catch(() => {})
    }

    return updated
  }, {
    access: { permission: 'knowledge.write' },
    body: t.Object({
      name: t.Optional(t.String({ minLength: 1 })),
      content: t.Optional(t.String()),
      parentId: t.Optional(t.String()),
      accessLevel: t.Optional(t.String()),
      tags: t.Optional(t.Array(t.String())),
      relatedEntityType: t.Optional(t.String()),
      relatedEntityId: t.Optional(t.String()),
    }),
  })

  // ── DELETE ──
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.knowledgeArticles.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Article not found' })

    await r.knowledgeArticles.delete(id)

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'delete', entityType: 'KnowledgeArticle',
      entityId: id, entityName: existing.name,
    }).catch(() => {})

    return { message: 'Deleted' }
  }, { access: { permission: 'knowledge.manage' } })

  // ── PUBLISH ──
  .post('/:id/publish', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.knowledgeArticles.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Article not found' })

    if (existing.isPublished) {
      return status(400, { message: 'Article is already published' })
    }

    const updated = await r.knowledgeArticles.update(id, { isPublished: true } as any)
    if (!updated) return status(500, { message: 'Failed to publish' })

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'KnowledgeArticle',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'isPublished', oldValue: false, newValue: true }],
    }).catch(() => {})

    return updated
  }, { access: { permission: 'knowledge.write' } })

  // ── SHARE ──
  .post('/:id/share', async ({ params: { orgId, id }, body, user, status }) => {
    const r = getRepos()
    const existing = await r.knowledgeArticles.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Article not found' })

    const sharedWith = [...(existing.sharedWith || [])]
    const alreadyShared = sharedWith.some((s: any) => String(s.userId) === body.userId)
    if (alreadyShared) {
      return status(400, { message: 'Already shared with this user' })
    }

    sharedWith.push({ userId: body.userId, canEdit: body.canEdit ?? false })
    const updated = await r.knowledgeArticles.update(id, { sharedWith } as any)
    if (!updated) return status(500, { message: 'Failed to share' })

    createAuditEntry({
      orgId, userId: user.id, module: 'helpdesk', action: 'update', entityType: 'KnowledgeArticle',
      entityId: id, entityName: existing.name,
      changes: [{ field: 'sharedWith', oldValue: existing.sharedWith, newValue: sharedWith }],
    }).catch(() => {})

    return updated
  }, {
    access: { permission: 'knowledge.write' },
    body: t.Object({
      userId: t.String(),
      canEdit: t.Optional(t.Boolean()),
    }),
  })
