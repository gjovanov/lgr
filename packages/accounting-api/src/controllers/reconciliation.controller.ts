import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

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
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.bankReconciliations.create({ ...body, orgId: params.orgId } as any)
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.bankReconciliations.update(params.id, body as any)
    return { bankReconciliation: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.bankReconciliations.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
