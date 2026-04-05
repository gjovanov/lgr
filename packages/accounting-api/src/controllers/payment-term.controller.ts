import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const paymentTermLineSchema = t.Object({
  type: t.Union([
    t.Literal('balance'),
    t.Literal('percent'),
    t.Literal('fixed'),
  ]),
  value: t.Number(),
  days: t.Number(),
  dayOfMonth: t.Optional(t.Number()),
  earlyDiscountPercent: t.Optional(t.Number()),
  earlyDiscountDays: t.Optional(t.Number()),
})

const paymentTermBody = t.Object({
  name: t.String({ minLength: 1 }),
  description: t.Optional(t.String()),
  lines: t.Array(paymentTermLineSchema),
})

export const paymentTermController = new Elysia({ prefix: '/org/:orgId/accounting/payment-terms' })
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

    const result = await r.paymentTerms.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { paymentTerms: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params }) => {
    const r = getRepos()
    const item = await r.paymentTerms.findById(params.id)
    return { paymentTerm: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.paymentTerms.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'payment_term', entityId: item.id, entityName: (item as any).name })

      return { paymentTerm: item }
    },
    { isSignIn: true, body: paymentTermBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user }) => {
      const r = getRepos()
      const existing = await r.paymentTerms.findById(id)
      const item = await r.paymentTerms.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'payment_term', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { paymentTerm: item }
    },
    { isSignIn: true, body: paymentTermBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user }) => {
    const r = getRepos()
    const existing = await r.paymentTerms.findById(id)
    await r.paymentTerms.update(id, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'payment_term', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
