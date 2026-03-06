import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { paymentOrderDao } from 'services/dao/invoicing/payment-order.dao'
import { PaymentOrder } from 'db/models'
import { paginateQuery } from 'services/utils/pagination'

function mapPaymentOrderBody(body: any) {
  const mapped = { ...body }
  // Map UI type values to schema enum
  if (mapped.type === 'outgoing') mapped.type = 'payment'
  if (mapped.type === 'incoming') mapped.type = 'receipt'
  // Map UI field names to schema field names
  if (mapped.selectedInvoiceIds) {
    mapped.invoiceIds = mapped.selectedInvoiceIds
    delete mapped.selectedInvoiceIds
  }
  // bankAccount (free text) → remove, use bankAccountId if provided
  delete mapped.bankAccount
  return mapped
}

export const paymentOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/payment-order' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const result = await paginateQuery(PaymentOrder, { orgId: params.orgId }, query)
    const populated = await PaymentOrder.populate(result.items, [
      { path: 'contactId', select: 'companyName firstName lastName' },
      { path: 'bankAccountId', select: 'name iban accountNumber' },
    ])
    const paymentOrders = populated.map((m: any) => {
      const contact = m.contactId
      let contactName = ''
      if (contact && typeof contact === 'object') {
        contactName = contact.companyName || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || ''
      }
      const bank = m.bankAccountId
      const bankAccountName = bank && typeof bank === 'object' ? (bank.name || bank.iban || bank.accountNumber || '') : ''
      // Map type back to UI-friendly values
      const type = m.type === 'payment' ? 'outgoing' : m.type === 'receipt' ? 'incoming' : m.type
      return {
        ...m.toJSON(),
        contactName,
        bankAccountName,
        type,
        contactId: contact?._id || m.contactId,
        bankAccountId: bank?._id || m.bankAccountId,
      }
    })
    return { paymentOrders, total: result.total, page: result.page, size: result.size }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const item = await paymentOrderDao.findById(params.id)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const mapped = mapPaymentOrderBody(body)
    const orderNumber = await paymentOrderDao.getNextOrderNumber(params.orgId)
    const item = await paymentOrderDao.create({ ...mapped, orgId: params.orgId, createdBy: user.id, orderNumber })
    return { paymentOrder: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const mapped = mapPaymentOrderBody(body)
    const item = await paymentOrderDao.update(params.id, mapped)
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
