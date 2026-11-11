import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { clientCreate, clientUpdate } from 'services/biz/server-owned'
import { buildSearchFilter } from 'services/biz/search.utils'

// A PUT never carries `orgId`: a document does not move between orgs (FR-20.7). `updateInOrg`
// drops it too; this answers 422 instead of ignoring it. What else a body may not choose (the
// fields the server sets) is refused in the handlers: `services/biz/server-owned.ts`.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

/** Who approved a timesheet: the server says, as the status changes; never the body. */
const approval = (status: unknown, was: unknown, userId: string) =>
  status === undefined || status === was ? {} : { approvedBy: status === 'approved' ? userId : null }

export const timesheetController = new Elysia({ prefix: '/org/:orgId/payroll/timesheet' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['notes'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.timesheets.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { timesheets: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.timesheets.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { timesheet: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const data = clientCreate('Timesheet', body, { orgId: params.orgId })
    const item = await r.timesheets.create({ ...data, ...approval(data.status, 'submitted', user.id), orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'timesheet', entityId: item.id })

    return { timesheet: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.timesheets.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    const data = clientUpdate('Timesheet', body, existing)
    const item = await r.timesheets.updateInOrg(params.id, params.orgId, { ...data, ...approval(data.status, (existing as any).status, user.id) } as any)
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'timesheet', entityId: params.id, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { timesheet: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    if (!(await r.timesheets.deleteInOrg(params.id, params.orgId))) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'timesheet', entityId: params.id })

    return { success: true }
  }, { isSignIn: true })
