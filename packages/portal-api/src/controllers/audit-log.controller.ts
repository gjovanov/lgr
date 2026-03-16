import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { queryAuditLogs } from 'services/biz/audit-log.service'

export const auditLogController = new Elysia({ prefix: '/org/:orgId/audit-logs' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const options: Record<string, any> = {}
    if (query.module) options.module = query.module
    if (query.entityType) options.entityType = query.entityType
    if (query.entityTypes) options.entityTypes = (query.entityTypes as string).split(',').filter(Boolean)
    if (query.userId) options.userId = query.userId
    if (query.action) options.action = query.action
    if (query.dateFrom) options.dateFrom = query.dateFrom
    if (query.dateTo) options.dateTo = query.dateTo
    options.page = Math.max(0, Number(query.page) || 0)
    options.size = query.size !== undefined ? Number(query.size) : 25

    return queryAuditLogs(orgId, options)
  }, { isSignIn: true })
