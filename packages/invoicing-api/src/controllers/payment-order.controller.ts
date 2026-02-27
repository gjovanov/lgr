import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { paymentOrderDao } from 'services/dao/invoicing/payment-order.dao'

export const paymentOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/payment-order' })
  .use(AppAuthService)
  .get('/', async ({ params }) => {
    const items = await paymentOrderDao.findByOrgId(params.orgId)
    return { paymentOrders: items }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await paymentOrderDao.findById(params.id)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const orderNumber = await paymentOrderDao.getNextOrderNumber(params.orgId)
    const item = await paymentOrderDao.create({ ...body, orgId: params.orgId, createdBy: user.id, orderNumber })
    return { paymentOrder: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await paymentOrderDao.update(params.id, body)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await paymentOrderDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
  .post('/:id/execute', async ({ params, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const item = await paymentOrderDao.findById(params.id)
    if (!item) return status(404, { message: 'Payment order not found' })
    if (item.status === 'executed')
      return status(400, { message: 'Payment order is already executed' })

    const updated = await paymentOrderDao.update(params.id, {
      status: 'executed',
      executedAt: new Date(),
      executedBy: user.id,
    })
    return { paymentOrder: updated }
  }, { isSignIn: true })
