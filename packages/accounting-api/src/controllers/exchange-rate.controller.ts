import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

// A PUT may carry any field of the document except `orgId`: a document never moves between
// orgs (FR-20.7). `updateInOrg` drops it too; this answers 422 instead of ignoring it.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

export const exchangeRateController = new Elysia({ prefix: '/org/:orgId/accounting/exchange-rate' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['fromCurrency', 'toCurrency'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.exchangeRates.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { exchangeRates: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    // A system rate (`orgId: null`, read by `currency.service` for every org) is readable here,
    // never writable: PUT and DELETE go through `…InOrg`, which cannot match a null org.
    const item = await r.exchangeRates.findByIdInOrg(params.id, params.orgId)
      ?? await r.exchangeRates.findOne({ id: params.id, orgId: null } as any).catch(() => null)
    if (!item) return status(404, { message: 'Not found' })
    return { exchangeRate: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.exchangeRates.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'exchange_rate', entityId: item.id, entityName: `${(item as any).fromCurrency}/${(item as any).toCurrency}` })

    return { exchangeRate: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.exchangeRates.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    const item = await r.exchangeRates.updateInOrg(params.id, params.orgId, body as any)
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'exchange_rate', entityId: params.id, entityName: `${(item as any).fromCurrency}/${(item as any).toCurrency}`, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { exchangeRate: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    const existing = await r.exchangeRates.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.exchangeRates.deleteInOrg(params.id, params.orgId)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'exchange_rate', entityId: params.id, entityName: existing ? `${(existing as any).fromCurrency}/${(existing as any).toCurrency}` : undefined })

    return { success: true }
  }, { isSignIn: true })
