import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

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
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.priceLists.findById(params.id)
    return { priceList: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.priceLists.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'price_list', entityId: item.id, entityName: (item as any).name })

    return { priceList: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user }) => {
    const r = getRepos()
    const existing = await r.priceLists.findById(params.id)
    const item = await r.priceLists.update(params.id, body as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'price_list', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { priceList: item }
  }, { isSignIn: true })
  .delete('/:id', async ({ params, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const existing = await r.priceLists.findById(params.id)
    if (!existing) return status(404, { message: 'Price list not found' })

    await r.priceLists.update(params.id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'deactivate', module: 'warehouse', entityType: 'price_list', entityId: params.id, entityName: (existing as any)?.name })

    return { message: 'Price list deactivated' }
  }, { isSignIn: true })
