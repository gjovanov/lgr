import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { queryAuditLogs, queryDistinctFilters, searchEntitiesByType, searchUsers } from 'services/biz/audit-log.service'

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
