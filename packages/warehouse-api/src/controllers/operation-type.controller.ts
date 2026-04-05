import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const operationTypeBody = t.Object({
  name: t.String({ minLength: 1 }),
  code: t.String({ minLength: 1 }),
  type: t.Union([
    t.Literal('incoming'),
    t.Literal('outgoing'),
    t.Literal('internal'),
  ]),
  warehouseId: t.String({ minLength: 1 }),
  defaultSourceLocationId: t.Optional(t.String()),
  defaultDestLocationId: t.Optional(t.String()),
  sequencePrefix: t.String({ minLength: 1 }),
  returnOperationTypeId: t.Optional(t.String()),
  createBackorder: t.Optional(t.Union([
    t.Literal('ask'),
    t.Literal('always'),
    t.Literal('never'),
  ])),
  reservationMethod: t.Optional(t.Union([
    t.Literal('at_confirm'),
    t.Literal('manual'),
  ])),
})

export const operationTypeController = new Elysia({ prefix: '/org/:orgId/warehouse/operation-types' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'code'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.operationTypes.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { operationTypes: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.operationTypes.findById(params.id)
    return { operationType: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.operationTypes.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'warehouse', entityType: 'operation_type', entityId: item.id, entityName: (item as any).name })

      return { operationType: item }
    },
    { isSignIn: true, body: operationTypeBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user }) => {
      const r = getRepos()
      const existing = await r.operationTypes.findById(id)
      const item = await r.operationTypes.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'operation_type', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { operationType: item }
    },
    { isSignIn: true, body: operationTypeBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user }) => {
    const r = getRepos()
    const existing = await r.operationTypes.findById(id)
    await r.operationTypes.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'warehouse', entityType: 'operation_type', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
