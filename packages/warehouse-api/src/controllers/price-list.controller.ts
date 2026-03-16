import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const priceListController = new Elysia({ prefix: '/org/:orgId/warehouse/price-list' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }

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
  .delete('/:id', async ({ params, user }) => {
    const r = getRepos()
    const existing = await r.priceLists.findById(params.id)
    await r.priceLists.delete(params.id)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'warehouse', entityType: 'price_list', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
