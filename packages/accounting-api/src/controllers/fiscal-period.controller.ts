import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const fiscalPeriodController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-period' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.fiscalPeriods.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { fiscalPeriods: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.fiscalPeriods.findById(params.id)
    return { fiscalPeriod: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.fiscalPeriods.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'fiscal_period', entityId: item.id, entityName: (item as any).name })

    return { fiscalPeriod: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.fiscalPeriods.findById(params.id)
    const item = await r.fiscalPeriods.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'fiscal_period', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { fiscalPeriod: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.fiscalPeriods.findById(params.id)
    await r.fiscalPeriods.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'fiscal_period', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
