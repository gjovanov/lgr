import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'

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

async function getNextOrderNumber(orgId: string): Promise<string> {
  const r = getRepos()
  const year = new Date().getFullYear()
  const prefix = `PO-${year}-`
  const orders = await r.paymentOrders.findMany(
    { orgId, orderNumber: { $regex: `^${prefix}` } } as any,
    { orderNumber: -1 },
  )
  if (!orders.length) return `${prefix}00001`
  const currentNum = parseInt(orders[0].orderNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

export const paymentOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/payment-order' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : ((query.sortOrder as string) === 'asc' ? 1 : -1)

    const result = await r.paymentOrders.findAll({ orgId: params.orgId }, { page, size, sort: { [sortBy]: sortOrder } })

    // Manual batch lookups to replace .populate()
    const contactIds = new Set<string>()
    const bankAccountIds = new Set<string>()
    for (const m of result.items) {
      if ((m as any).contactId) contactIds.add((m as any).contactId)
      if ((m as any).bankAccountId) bankAccountIds.add((m as any).bankAccountId)
    }

    const [contacts, bankAccounts] = await Promise.all([
      contactIds.size > 0 ? r.contacts.findMany({ id: { $in: [...contactIds] } } as any) : [],
      bankAccountIds.size > 0 ? r.bankAccounts.findMany({ id: { $in: [...bankAccountIds] } } as any) : [],
    ])

    const contactMap = new Map(contacts.map(c => [c.id, c]))
    const bankAccountMap = new Map(bankAccounts.map(b => [b.id, b]))

    const paymentOrders = result.items.map((m: any) => {
      const contact = m.contactId ? contactMap.get(m.contactId) : null
      const bank = m.bankAccountId ? bankAccountMap.get(m.bankAccountId) : null
      const contactName = contact
        ? ((contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || '')
        : ''
      const bankAccountName = bank ? ((bank as any).name || (bank as any).iban || (bank as any).accountNumber || '') : ''
      // Map type back to UI-friendly values
      const type = m.type === 'payment' ? 'outgoing' : m.type === 'receipt' ? 'incoming' : m.type
      return {
        ...m,
        contactName,
        bankAccountName,
        type,
      }
    })
    return { paymentOrders, total: result.total, page: result.page, size: result.size }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.paymentOrders.findById(params.id)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const mapped = mapPaymentOrderBody(body)
    const orderNumber = await getNextOrderNumber(params.orgId)
    const item = await r.paymentOrders.create({ ...mapped, orgId: params.orgId, createdBy: user.id, orderNumber } as any)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body }) => {
    const r = getRepos()
    const mapped = mapPaymentOrderBody(body)
    const item = await r.paymentOrders.update(params.id, mapped as any)
    return { paymentOrder: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params }) => {
    const r = getRepos()
    await r.paymentOrders.delete(params.id)
    return { success: true }
  }, { isSignIn: true })
  .post('/:id/execute', async ({ params, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const item = await r.paymentOrders.findById(params.id)
    if (!item) return status(404, { message: 'Payment order not found' })
    if (item.status === 'executed')
      return status(400, { message: 'Payment order is already executed' })

    const updated = await r.paymentOrders.update(params.id, {
      status: 'executed',
      executedAt: new Date(),
      executedBy: user.id,
    } as any)
    return { paymentOrder: updated }
  }, { isSignIn: true })
