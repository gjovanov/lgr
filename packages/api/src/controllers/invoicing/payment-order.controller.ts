import { Elysia } from 'elysia'
import { AuthService } from '../../auth/auth.service.js'
import { paymentOrderDao } from 'services/dao/invoicing/payment-order.dao'
import { PaymentOrder } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const paymentOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/payment-order' })
  .use(AuthService)
  .get('/', async ({ params, query }) => {
    const result = await paginateQuery(PaymentOrder, { orgId: params.orgId }, query)
    return { paymentOrders: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await paymentOrderDao.findById(params.id)
    return { item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const orderNumber = await paymentOrderDao.getNextOrderNumber(params.orgId)
    const item = await paymentOrderDao.create({ ...body, orgId: params.orgId, createdBy: user.id, orderNumber })
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
