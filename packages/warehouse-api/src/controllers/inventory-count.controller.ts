import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { InventoryCount } from 'db/models'
import { inventoryCountDao } from 'services/dao/warehouse/inventory-count.dao'
import { paginateQuery } from 'services/utils/pagination'

export const inventoryCountController = new Elysia({ prefix: '/org/:orgId/warehouse/inventory-count' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const filter: Record<string, any> = { orgId }
    const result = await paginateQuery(InventoryCount, filter, query)
    return { inventoryCounts: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await inventoryCountDao.findById(params.id)
    return { inventoryCount: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const countNumber = await inventoryCountDao.getNextCountNumber(params.orgId)
    const item = await inventoryCountDao.create({ ...body, orgId: params.orgId, createdBy: user.id, countNumber })
    return { inventoryCount: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await inventoryCountDao.update(params.id, body)
    return { inventoryCount: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await inventoryCountDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
  .post('/:id/complete', async ({ params }) => {
    const item = await inventoryCountDao.update(params.id, { status: 'completed', completedAt: new Date() })
    return { inventoryCount: item }
  }, { isSignIn: true })
