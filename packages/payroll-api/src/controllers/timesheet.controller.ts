import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const timesheetController = new Elysia({ prefix: '/org/:orgId/payroll/timesheet' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.timesheets.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { timesheets: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.timesheets.findById(params.id)
    return { timesheet: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.timesheets.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'timesheet', entityId: item.id })

    return { timesheet: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.timesheets.findById(params.id)
    const item = await r.timesheets.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'timesheet', entityId: params.id, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { timesheet: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    await r.timesheets.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'timesheet', entityId: params.id })

    return { success: true }
  }, { isSignIn: true })
