import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const exchangeRateController = new Elysia({ prefix: '/org/:orgId/accounting/exchange-rate' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.exchangeRates.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { exchangeRates: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.exchangeRates.findById(params.id)
    return { exchangeRate: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.exchangeRates.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'exchange_rate', entityId: item.id, entityName: `${(item as any).fromCurrency}/${(item as any).toCurrency}` })

    return { exchangeRate: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.exchangeRates.findById(params.id)
    const item = await r.exchangeRates.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'exchange_rate', entityId: params.id, entityName: `${(item as any).fromCurrency}/${(item as any).toCurrency}`, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { exchangeRate: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.exchangeRates.findById(params.id)
    await r.exchangeRates.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'exchange_rate', entityId: params.id, entityName: existing ? `${(existing as any).fromCurrency}/${(existing as any).toCurrency}` : undefined })

    return { success: true }
  }, { isSignIn: true })
