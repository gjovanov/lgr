import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { exchangeRateDao } from 'services/dao/accounting/exchange-rate.dao'

export const exchangeRateController = new Elysia({ prefix: '/org/:orgId/accounting/exchange-rate' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await exchangeRateDao.findByOrgId(params.orgId)
    return { exchangeRates: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await exchangeRateDao.findById(params.id)
    return { exchangeRate: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await exchangeRateDao.create({ ...body, orgId: params.orgId })
    return { exchangeRate: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await exchangeRateDao.update(params.id, body)
    return { exchangeRate: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await exchangeRateDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
