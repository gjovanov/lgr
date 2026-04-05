import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const stockLocationBody = t.Object({
  name: t.String({ minLength: 1 }),
  code: t.Optional(t.String()),
  type: t.Union([
    t.Literal('internal'),
    t.Literal('supplier'),
    t.Literal('customer'),
    t.Literal('inventory_loss'),
    t.Literal('production'),
    t.Literal('transit'),
    t.Literal('view'),
  ]),
  warehouseId: t.Optional(t.String()),
  parentId: t.Optional(t.String()),
  barcode: t.Optional(t.String()),
  isScrapLocation: t.Optional(t.Boolean()),
  isReturnLocation: t.Optional(t.Boolean()),
  removalStrategy: t.Optional(t.Union([
    t.Literal('fifo'),
    t.Literal('lifo'),
    t.Literal('fefo'),
  ])),
})

export const stockLocationController = new Elysia({ prefix: '/org/:orgId/warehouse/locations' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code', 'barcode'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.stockLocations.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { stockLocations: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.stockLocations.findById(params.id)
    return { stockLocation: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.stockLocations.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'stock_location', entityId: item.id, entityName: (item as any).name })

      return { stockLocation: item }
    },
    { isSignIn: true, body: stockLocationBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user }) => {
      const r = getRepos()
      const existing = await r.stockLocations.findById(id)
      const item = await r.stockLocations.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'stock_location', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { stockLocation: item }
    },
    { isSignIn: true, body: stockLocationBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user }) => {
    const r = getRepos()
    const existing = await r.stockLocations.findById(id)
    await r.stockLocations.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'warehouse', entityType: 'stock_location', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
