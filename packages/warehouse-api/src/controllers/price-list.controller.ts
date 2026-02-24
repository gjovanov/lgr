import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { priceListDao } from 'services/dao/warehouse/price-list.dao'

export const priceListController = new Elysia({ prefix: '/org/:orgId/warehouse/price-list' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await priceListDao.findByOrgId(params.orgId)
    return { priceLists: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await priceListDao.findById(params.id)
    return { priceList: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await priceListDao.create({ ...body, orgId: params.orgId })
    return { priceList: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await priceListDao.update(params.id, body)
    return { priceList: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await priceListDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
