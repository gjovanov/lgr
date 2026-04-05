import { Elysia, t } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const posPaymentMethodBody = t.Object({
  name: t.String({ minLength: 1 }),
  code: t.String({ minLength: 1 }),
  type: t.Union([
    t.Literal('cash'),
    t.Literal('card'),
    t.Literal('mobile'),
    t.Literal('voucher'),
    t.Literal('bank'),
  ]),
  journalId: t.Optional(t.String()),
  isCashCount: t.Optional(t.Boolean()),
})

export const posPaymentMethodController = new Elysia({ prefix: '/org/:orgId/pos/payment-methods' })
  .use(AuthService)
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

    const result = await r.posPaymentMethods.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { posPaymentMethods: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.posPaymentMethods.findById(params.id)
    return { posPaymentMethod: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.posPaymentMethods.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'pos', entityType: 'pos_payment_method', entityId: item.id, entityName: (item as any).name })

      return { posPaymentMethod: item }
    },
    { isSignIn: true, body: posPaymentMethodBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user }) => {
      const r = getRepos()
      const existing = await r.posPaymentMethods.findById(id)
      const item = await r.posPaymentMethods.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'pos', entityType: 'pos_payment_method', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { posPaymentMethod: item }
    },
    { isSignIn: true, body: posPaymentMethodBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user }) => {
    const r = getRepos()
    const existing = await r.posPaymentMethods.findById(id)
    await r.posPaymentMethods.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'pos', entityType: 'pos_payment_method', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
