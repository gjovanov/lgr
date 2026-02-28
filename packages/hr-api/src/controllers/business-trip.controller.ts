import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { businessTripDao } from 'services/dao/hr/business-trip.dao'
import { BusinessTrip } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const businessTripController = new Elysia({ prefix: '/org/:orgId/hr/business-trip' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(BusinessTrip, filter, query)
    return { businessTrips: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await businessTripDao.findById(params.id)
    return { businessTrip: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await businessTripDao.create({ ...body, orgId: params.orgId })
    return { businessTrip: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await businessTripDao.update(params.id, body)
    return { businessTrip: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await businessTripDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
