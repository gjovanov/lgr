import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

// A PUT may carry any field of the document except `orgId`: a document never moves between
// orgs (FR-20.7). `updateInOrg` drops it too; this answers 422 instead of ignoring it.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

export const priceListController = new Elysia({ prefix: '/org/:orgId/warehouse/price-list' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const result = await r.priceLists.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { priceLists: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.priceLists.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { priceList: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.priceLists.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'price_list', entityId: item.id, entityName: (item as any).name })

    return { priceList: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.priceLists.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    const item = await r.priceLists.updateInOrg(params.id, params.orgId, body as any)
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'price_list', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { priceList: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const existing = await r.priceLists.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Price list not found' })

    await r.priceLists.updateInOrg(params.id, params.orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'deactivate', module: 'warehouse', entityType: 'price_list', entityId: params.id, entityName: (existing as any)?.name })

    return { message: 'Price list deactivated' }
  }, { isSignIn: true })
