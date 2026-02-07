import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { exchangeRateDao } from 'services/dao/accounting/exchange-rate.dao'

export const exchangeRateController = new Elysia({ prefix: '/org/:orgId/accounting/exchange-rate' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await exchangeRateDao.findByOrgId(params.orgId)
    return { exchangeRates: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await exchangeRateDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await exchangeRateDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await exchangeRateDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await exchangeRateDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
