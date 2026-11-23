import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const taxMapSchema = t.Object({
  sourceTaxRate: t.Number(),
  destinationTaxRate: t.Number(),
  destinationAccountId: t.Optional(t.String()),
})

const fiscalPositionBody = t.Object({
  name: t.String({ minLength: 1 }),
  autoApply: t.Optional(t.Boolean()),
  country: t.Optional(t.String()),
  taxMaps: t.Array(taxMapSchema),
})

export const fiscalPositionController = new Elysia({ prefix: '/org/:orgId/accounting/fiscal-positions' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'country'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.fiscalPositions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { fiscalPositions: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.fiscalPositions.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { fiscalPosition: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.fiscalPositions.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'fiscal_position', entityId: item.id, entityName: (item as any).name })

      return { fiscalPosition: item }
    },
    { isSignIn: true, body: fiscalPositionBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()
      const existing = await r.fiscalPositions.findByIdInOrg(id, orgId)
      if (!existing) return status(404, { message: 'Not found' })
      const item = await r.fiscalPositions.updateInOrg(id, orgId, body as any)
      if (!item) return status(404, { message: 'Not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'fiscal_position', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { fiscalPosition: item }
    },
    { isSignIn: true, body: fiscalPositionBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.fiscalPositions.findByIdInOrg(id, orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.fiscalPositions.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'fiscal_position', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
