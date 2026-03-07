import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const taxReturnController = new Elysia({ prefix: '/org/:orgId/accounting/tax-return' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.taxReturns.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { taxReturns: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.taxReturns.findById(params.id)
    return { taxReturn: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.taxReturns.create({ ...body, orgId: params.orgId } as any)
    return { taxReturn: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.taxReturns.update(params.id, body as any)
    return { taxReturn: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.taxReturns.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
