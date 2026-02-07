import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { businessTripDao } from 'services/dao/hr/business-trip.dao'

export const businessTripController = new Elysia({ prefix: '/org/:orgId/hr/business-trip' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await businessTripDao.findByOrgId(params.orgId)
    return { businessTrips: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await businessTripDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await businessTripDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await businessTripDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await businessTripDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
