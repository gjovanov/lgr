import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

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
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.fiscalPeriods.create({ ...body, orgId: params.orgId } as any)
    return { fiscalPeriod: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.fiscalPeriods.update(params.id, body as any)
    return { fiscalPeriod: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.fiscalPeriods.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
