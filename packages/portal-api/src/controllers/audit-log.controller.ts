import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry, queryAuditLogs, queryDistinctFilters, searchEntitiesByType, searchUsers, queryByCorrelationId } from 'services/biz/audit-log.service'

export const auditLogController = new Elysia({ prefix: '/org/:orgId/audit-logs' })
  .use(AuthService)
  .get('/filters', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return queryDistinctFilters(orgId)
  }, { isSignIn: true })
  .get('/search-entities', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!query.entityType) return status(400, { message: 'entityType is required' })
    const results = await searchEntitiesByType(orgId, query.entityType as string, (query.q as string) || '', 10)
    return { results }
  }, { isSignIn: true })
  .get('/correlation/:correlationId', async ({ params: { orgId, correlationId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const entries = await queryByCorrelationId(orgId, correlationId)
    return { entries }
  }, { isSignIn: true })
  .get('/search-users', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const results = await searchUsers(orgId, (query.q as string) || '', 10)
    return { results }
  }, { isSignIn: true })
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const options: Record<string, any> = {}
    if (query.module) options.module = query.module
    if (query.modules) options.modules = (query.modules as string).split(',').filter(Boolean)
    if (query.entityType) options.entityType = query.entityType
    if (query.entityTypes) options.entityTypes = (query.entityTypes as string).split(',').filter(Boolean)
    if (query.entityIds) options.entityIds = (query.entityIds as string).split(',').filter(Boolean)
    if (query.userId) options.userId = query.userId
    if (query.userIds) options.userIds = (query.userIds as string).split(',').filter(Boolean)
    if (query.action) options.action = query.action
    if (query.actions) options.actions = (query.actions as string).split(',').filter(Boolean)
    if (query.dateFrom) options.dateFrom = query.dateFrom
    if (query.dateTo) options.dateTo = query.dateTo
    options.page = Math.max(0, Number(query.page) || 0)
    options.size = query.size !== undefined ? Number(query.size) : 25

    return queryAuditLogs(orgId, options)
  }, { isSignIn: true })
  .post('/', async ({ params: { orgId }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    createAuditEntry({
      orgId,
      userId: user.id,
      operatorCode: user.operatorCode,
      action: body.action,
      module: body.module,
      entityType: body.entityType,
      entityId: body.entityId,
      entityName: body.entityName,
      changes: body.changes,
    })
    return { success: true }
  }, {
    isSignIn: true,
    body: t.Object({
      // S-28: any member may post here, and the only thing a client writes is a note on a
      // record (`EntityNotesPanel`). Any other action would be a forged line in the trail an NRA
      // auditor reads; the server writes those itself.
      action: t.Literal('note'),
      module: t.String(),
      entityType: t.String(),
      entityId: t.String(),
      entityName: t.Optional(t.String()),
      changes: t.Optional(t.Array(t.Object({
        field: t.String(),
        oldValue: t.Any(),
        newValue: t.Any(),
      }))),
    }),
  })
