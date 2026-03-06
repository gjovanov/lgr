import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { cashOrderDao } from 'services/dao/invoicing/cash-order.dao'
import { CashOrder } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

export const cashOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/cash-order' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const result = await paginateQuery(CashOrder, { orgId: params.orgId }, query)
    const populated = await CashOrder.populate(result.items, [
      { path: 'contactId', select: 'companyName firstName lastName' },
      { path: 'accountId', select: 'code name' },
      { path: 'counterAccountId', select: 'code name' },
    ])
    const cashOrders = populated.map((m: any) => {
      const contact = m.contactId
      let contactName = ''
      if (contact && typeof contact === 'object') {
        contactName = contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || ''
      }
      const account = m.accountId
      const accountName = account && typeof account === 'object' ? (account.name || account.code || '') : ''
      const counterAccount = m.counterAccountId
      const counterAccountName = counterAccount && typeof counterAccount === 'object' ? (counterAccount.name || counterAccount.code || '') : ''
      return {
        ...m.toJSON(),
        contactName,
        accountName,
        counterAccountName,
        contactId: contact?._id || m.contactId,
        accountId: account?._id || m.accountId,
        counterAccountId: counterAccount?._id || m.counterAccountId,
      }
    })
    return { cashOrders, total: result.total, page: result.page, size: result.size }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await cashOrderDao.findById(params.id)
    return { cashOrder: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const orderNumber = await cashOrderDao.getNextOrderNumber(params.orgId)
    const item = await cashOrderDao.create({ ...body, orgId: params.orgId, createdBy: user.id, orderNumber })
    return { cashOrder: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const item = await cashOrderDao.update(params.id, body)
    return { cashOrder: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    await cashOrderDao.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
