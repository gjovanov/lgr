import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const stockLotBody = t.Object({
  name: t.String({ minLength: 1 }),
  productId: t.String({ minLength: 1 }),
  trackingType: t.Union([
    t.Literal('lot'),
    t.Literal('serial'),
  ]),
  expiryDate: t.Optional(t.String()),
  notes: t.Optional(t.String()),
})

export const stockLotController = new Elysia({ prefix: '/org/:orgId/warehouse/lots' })
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
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.stockLots.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { stockLots: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.stockLots.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { stockLot: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.stockLots.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'stock_lot', entityId: item.id, entityName: (item as any).name })

      return { stockLot: item }
    },
    { isSignIn: true, body: stockLotBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()
      const existing = await r.stockLots.findByIdInOrg(id, orgId)
      if (!existing) return status(404, { message: 'Not found' })
      const item = await r.stockLots.updateInOrg(id, orgId, body as any)
      if (!item) return status(404, { message: 'Not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'stock_lot', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { stockLot: item }
    },
    { isSignIn: true, body: stockLotBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.stockLots.findByIdInOrg(id, orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.stockLots.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'warehouse', entityType: 'stock_lot', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
