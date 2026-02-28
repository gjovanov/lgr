import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { PriceList } from 'db/models'
import { priceListDao } from 'services/dao/warehouse/price-list.dao'
import { paginateQuery } from 'services/utils/pagination'

export const priceListController = new Elysia({ prefix: '/org/:orgId/warehouse/price-list' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(PriceList, filter, query, { sortBy: 'name', sortOrder: 'asc' })
    return { priceLists: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await priceListDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await priceListDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await priceListDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await priceListDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
