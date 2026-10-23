import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'

// A PUT may carry any field of the document except `orgId`: a document never moves between
// orgs (FR-20.7). `updateInOrg` drops it too; this answers 422 instead of ignoring it.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

export const bankAccountController = new Elysia({ prefix: '/org/:orgId/accounting/bank-account' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'bankName'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.bankAccounts.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { bankAccounts: result.items, ...result }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.bankAccounts.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { bankAccount: item }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.bankAccounts.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'bank_account', entityId: item.id, entityName: (item as any).name })

    return { bankAccount: item }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.bankAccounts.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    const item = await r.bankAccounts.updateInOrg(params.id, params.orgId, body as any)
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'bank_account', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { bankAccount: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    const existing = await r.bankAccounts.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.bankAccounts.deleteInOrg(params.id, params.orgId)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'bank_account', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
