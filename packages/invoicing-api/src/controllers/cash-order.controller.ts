import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

async function getNextOrderNumber(orgId: string): Promise<string> {
  const r = getRepos()
  const year = new Date().getFullYear()
  const prefix = `CO-${year}-`
  const orders = await r.cashOrders.findMany(
    { orgId, orderNumber: { $regex: `^${prefix}` } } as any,
    { orderNumber: -1 },
  )
  if (!orders.length) return `${prefix}00001`
  const currentNum = parseInt(orders[0].orderNumber.replace(prefix, ''), 10)
  return `${prefix}${String(currentNum + 1).padStart(5, '0')}`
}

export const cashOrderController = new Elysia({ prefix: '/org/:orgId/invoicing/cash-order' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : ((query.sortOrder as string) === 'asc' ? 1 : -1)

    const result = await r.cashOrders.findAll({ orgId: params.orgId }, { page, size, sort: { [sortBy]: sortOrder } })

    // Manual batch lookups to replace .populate()
    const contactIds = new Set<string>()
    const accountIds = new Set<string>()
    for (const m of result.items) {
      if ((m as any).contactId) contactIds.add((m as any).contactId)
      if ((m as any).accountId) accountIds.add((m as any).accountId)
      if ((m as any).counterAccountId) accountIds.add((m as any).counterAccountId)
    }

    const [contacts, accounts] = await Promise.all([
      contactIds.size > 0 ? r.contacts.findMany({ id: { $in: [...contactIds] } } as any) : [],
      accountIds.size > 0 ? r.accounts.findMany({ id: { $in: [...accountIds] } } as any) : [],
    ])

    const contactMap = new Map(contacts.map(c => [c.id, c]))
    const accountMap = new Map(accounts.map(a => [a.id, a]))

    const cashOrders = result.items.map((m: any) => {
      const contact = m.contactId ? contactMap.get(m.contactId) : null
      const account = m.accountId ? accountMap.get(m.accountId) : null
      const counterAccount = m.counterAccountId ? accountMap.get(m.counterAccountId) : null
      const contactName = contact
        ? ((contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || '')
        : ''
      const accountName = account ? ((account as any).name || (account as any).code || '') : ''
      const counterAccountName = counterAccount ? ((counterAccount as any).name || (counterAccount as any).code || '') : ''
      return {
        ...m,
        contactName,
        accountName,
        counterAccountName,
      }
    })
    return { cashOrders, total: result.total, page: result.page, size: result.size }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.cashOrders.findById(params.id)
    return { cashOrder: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const orderNumber = await getNextOrderNumber(params.orgId)
    const item = await r.cashOrders.create({ ...body, orgId: params.orgId, createdBy: user.id, orderNumber } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'cash_order', entityId: item.id, entityName: orderNumber })

    return { cashOrder: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.cashOrders.findById(params.id)
    const item = await r.cashOrders.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'cash_order', entityId: params.id, entityName: (existing as any)?.orderNumber, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { cashOrder: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.cashOrders.findById(params.id)
    await r.cashOrders.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'cash_order', entityId: params.id, entityName: (existing as any)?.orderNumber })

    return { success: true }
  }, { isSignIn: true })
