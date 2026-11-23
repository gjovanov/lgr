import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

const journalBody = t.Object({
  name: t.String({ minLength: 1 }),
  code: t.String({ minLength: 1 }),
  type: t.Union([
    t.Literal('sale'),
    t.Literal('purchase'),
    t.Literal('cash'),
    t.Literal('bank'),
    t.Literal('general'),
  ]),
  defaultDebitAccountId: t.Optional(t.String()),
  defaultCreditAccountId: t.Optional(t.String()),
  bankAccountId: t.Optional(t.String()),
  currency: t.Optional(t.String()),
  sequencePrefix: t.Optional(t.String()),
})

export const journalConfigController = new Elysia({ prefix: '/org/:orgId/accounting/journals' })
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

    const result = await r.journals.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { journals: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.journals.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { journal: item }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user }) => {
      const r = getRepos()
      const item = await r.journals.create({ ...body, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'journal', entityId: item.id, entityName: (item as any).name })

      return { journal: item }
    },
    { isSignIn: true, body: journalBody },
  )
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      const r = getRepos()
      const existing = await r.journals.findByIdInOrg(id, orgId)
      if (!existing) return status(404, { message: 'Not found' })
      const item = await r.journals.updateInOrg(id, orgId, body as any)
      if (!item) return status(404, { message: 'Not found' })

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'journal', entityId: id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

      return { journal: item }
    },
    { isSignIn: true, body: journalBody },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    const r = getRepos()
    const existing = await r.journals.findByIdInOrg(id, orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.journals.updateInOrg(id, orgId, { isActive: false, deactivatedAt: new Date() } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'journal', entityId: id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
