import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const leaveTypeController = new Elysia({ prefix: '/org/:orgId/hr/leave-type' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.leaveTypes.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { leaveTypes: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.leaveTypes.findById(params.id)
    return { leaveType: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.leaveTypes.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'hr', entityType: 'leave_type', entityId: item.id, entityName: (item as any).name })

    return { leaveType: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.leaveTypes.findById(params.id)
    const item = await r.leaveTypes.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'hr', entityType: 'leave_type', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { leaveType: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.leaveTypes.findById(params.id)
    await r.leaveTypes.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'hr', entityType: 'leave_type', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
