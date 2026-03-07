import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

export const businessTripController = new Elysia({ prefix: '/org/:orgId/hr/business-trip' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.businessTrips.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { businessTrips: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.businessTrips.findById(params.id)
    return { businessTrip: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.businessTrips.create({ ...body, orgId: params.orgId } as any)
    return { businessTrip: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const item = await r.businessTrips.update(params.id, body as any)
    return { businessTrip: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.businessTrips.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
