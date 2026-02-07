import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { paymentOrderDao } from 'services/dao/invoicing/payment-order.dao'

export const paymentOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/payment-order' })
  .use(AuthService)
  .get('/', async ({ params }) => {
    const items = await paymentOrderDao.findByOrgId(params.orgId)
    return { paymentOrders: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await paymentOrderDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body }) => {
    const item = await paymentOrderDao.create({ ...body, orgId: params.orgId })
    return { item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await paymentOrderDao.update(params.id, body)
    return { item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await paymentOrderDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
