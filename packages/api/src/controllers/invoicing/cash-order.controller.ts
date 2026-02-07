import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { cashOrderDao } from 'services/dao/invoicing/cash-order.dao'

export const cashOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/cash-order' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await cashOrderDao.findByOrgId(params.orgId)
    return { cashOrders: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await cashOrderDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await cashOrderDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await cashOrderDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await cashOrderDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
