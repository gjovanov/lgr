import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { TAX_RETURN_STATUSES } from 'db/models'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { withoutPersonalId } from 'services/biz/vat-files/vat-return.service'

const OBJECT_ID = '^[0-9a-fA-F]{24}$'
const dateField = () => t.Union([t.String({ format: 'date' }), t.String({ format: 'date-time' })])

const returnType = t.Union([
  t.Literal('vat'),
  t.Literal('income_tax'),
  t.Literal('corporate_tax'),
  t.Literal('payroll_tax'),
])
const period = t.Object({ from: dateField(), to: dateField() })

const optionalFields = {
  status: t.Optional(t.Union(TAX_RETURN_STATUSES.map(s => t.Literal(s)))),
  totalTax: t.Optional(t.Number()),
  totalInput: t.Optional(t.Number()),
  totalOutput: t.Optional(t.Number()),
  netPayable: t.Optional(t.Number()),
  lines: t.Optional(t.Array(t.Object({
    description: t.String({ minLength: 1 }),
    taxableAmount: t.Number(),
    taxRate: t.Number(),
    taxAmount: t.Number(),
    accountId: t.String({ pattern: OBJECT_ID }),
  }))),
  filedAt: t.Optional(dateField()),
  filedBy: t.Optional(t.String({ pattern: OBJECT_ID })),
  attachments: t.Optional(t.Array(t.String({ pattern: OBJECT_ID }))),
  // A document never moves between orgs (FR-20.7). `updateInOrg` drops it too; this answers 422
  // instead of ignoring it.
  orgId: t.Optional(t.Never()),
}

const createBody = t.Object({ type: returnType, period, ...optionalFields })
const updateBody = t.Object({ type: t.Optional(returnType), period: t.Optional(period), ...optionalFields })

/**
 * A return with a `kind` belongs to its filing flow (FR-25 §3.8, `vat.controller.ts`). Open to these
 * routes, `accounting.write` could file what `accounting.file` guards, or put a filed return back to
 * draft and unfreeze it. No body here can set a `kind`: the schemas above leave it out.
 */
const filingOwned = (status: any) =>
  status(409, { code: 'tax_return_filing_owned', message: 'This return belongs to its filing flow, and does not change here.' })

export const taxReturnController = new Elysia({ prefix: '/org/:orgId/accounting/tax-return' })
  .use(AppAuthService)
  .get('/', async ({ params, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId: params.orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'period'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.taxReturns.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    const taxReturns = result.items.map(withoutPersonalId)
    return { taxReturns, ...result, items: taxReturns }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.taxReturns.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { taxReturn: withoutPersonalId(item) }
  }, { isSignIn: true })
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.taxReturns.create({ ...body, orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'accounting', entityType: 'tax_return', entityId: item.id, entityName: (item as any).name })

    return { taxReturn: item }
  }, { isSignIn: true, body: createBody })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.taxReturns.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    if (existing.kind) return filingOwned(status)
    const item = await r.taxReturns.updateInOrg(params.id, params.orgId, body as any)
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'accounting', entityType: 'tax_return', entityId: params.id, entityName: (item as any).name, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { taxReturn: item }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    const existing = await r.taxReturns.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    if (existing.kind) return filingOwned(status)
    await r.taxReturns.deleteInOrg(params.id, params.orgId)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'accounting', entityType: 'tax_return', entityId: params.id, entityName: (existing as any)?.name })

    return { success: true }
  }, { isSignIn: true })
