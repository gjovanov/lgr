import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry, queryAuditLogs, queryDistinctFilters, searchEntitiesByType, searchUsers, queryByCorrelationId } from 'services/biz/audit-log.service'
import { auditReadScope } from 'services/biz/route-permission'

/**
 * S-29: the whole trail is `admin.audit`'s (the Audit Log page and its search helpers). Anyone else
 * reads the history of ONE record, in a module they read: the history and notes panels on a record.
 */
const WHOLE_TRAIL = { code: 'permission_required', message: 'Reading the audit trail needs admin.audit' } as const

export const auditLogController = new Elysia({ prefix: '/org/:orgId/audit-logs' })
  .use(AuthService)
  .get('/filters', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (auditReadScope(user) !== 'all') return status(403, WHOLE_TRAIL)
    return queryDistinctFilters(orgId)
  }, { isSignIn: true })
  .get('/search-entities', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (auditReadScope(user) !== 'all') return status(403, WHOLE_TRAIL)
    if (!query.entityType) return status(400, { message: 'entityType is required' })
    const results = await searchEntitiesByType(orgId, query.entityType as string, (query.q as string) || '', 10)
    return { results }
  }, { isSignIn: true })
  .get('/correlation/:correlationId', async ({ params: { orgId, correlationId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (auditReadScope(user) !== 'all') return status(403, WHOLE_TRAIL)
    const entries = await queryByCorrelationId(orgId, correlationId)
    return { entries }
  }, { isSignIn: true })
  .get('/search-users', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (auditReadScope(user) !== 'all') return status(403, WHOLE_TRAIL)
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
    // ⚠ The panels on a record send `entityId`, which was dropped: each showed the latest entries
    // of every record of its TYPE, another product's history on this product's page.
    if (query.entityId) options.entityIds = [String(query.entityId)]
    else if (query.entityIds) options.entityIds = (query.entityIds as string).split(',').filter(Boolean)

    const scope = auditReadScope(user)
    if (scope !== 'all') {
      if (!options.entityType || options.entityIds?.length !== 1) {
        return status(403, { code: 'permission_required', message: "Reading the audit trail needs admin.audit; a record's history needs its entityType and entityId" })
      }
      const asked: string[] | null = options.modules ?? (options.module ? [options.module] : null)
      const modules = asked ? asked.filter(m => scope.includes(m)) : scope
      if (!modules.length) return status(403, WHOLE_TRAIL)
      options.modules = modules
      delete options.module
      delete options.entityTypes
    }
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
