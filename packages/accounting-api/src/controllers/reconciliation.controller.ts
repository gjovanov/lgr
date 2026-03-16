import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const reconciliationController = new Elysia({ prefix: '/org/:orgId/accounting/reconciliation' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.bankReconciliations.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { reconciliations: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.bankReconciliations.findById(params.id)
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.bankReconciliations.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'reconciliation', entityId: item.id })

    return { bankReconciliation: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.bankReconciliations.findById(params.id)
    const item = await r.bankReconciliations.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'reconciliation', entityId: params.id, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { bankReconciliation: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    await r.bankReconciliations.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'reconciliation', entityId: params.id })

    return { success: true }
  }, { isSignIn: true })
