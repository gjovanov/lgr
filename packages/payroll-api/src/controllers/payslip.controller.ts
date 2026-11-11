import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges, recordAuditEntry } from 'services/biz/audit-log.service'
import { clientCreate, clientUpdate } from 'services/biz/server-owned'
import { buildSearchFilter } from 'services/biz/search.utils'
import { forOrg } from 'services/biz/personal-data/personal-data.service'
import { openPayslip } from 'services/biz/payroll/bg/run.service'
import { payslipView } from 'services/biz/payroll/bg/views'
import { lockedAnswer, RECORD_REFUSAL, REVEAL_REASON } from './answers.js'

// A PUT never carries `orgId`: a document does not move between orgs (FR-20.7). `updateInOrg`
// drops it too; this answers 422 instead of ignoring it. What else a body may not choose (the
// fields the server sets) is refused in the handlers: `services/biz/server-owned.ts`.
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

export const payslipController = new Elysia({ prefix: '/org/:orgId/payroll/payslip' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query }) => {
    const r = getRepos()
    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['employeeName'])
      Object.assign(filter, searchFilter)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.payslips.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    const items = result.items.map(payslipView)
    return { ...result, payslips: items, items }
  }, { isSignIn: true })
  .get('/:id', async ({ params, status }) => {
    const r = getRepos()
    const item = await r.payslips.findByIdInOrg(params.id, params.orgId)
    if (!item) return status(404, { message: 'Not found' })
    return { payslip: payslipView(item) }
  }, { isSignIn: true })
  // FR-25 §3.12: a Bulgarian payslip's amounts are sealed. The route rule needs `payroll.personal`,
  // and the audit row is written before the value leaves.
  .post(
    '/:id/reveal',
    async ({ params, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const item: any = await r.payslips.findByIdInOrg(params.id, params.orgId)
      if (!item) return status(404, { message: 'Not found' })
      if (!item.sealed) return status(422, { message: 'This payslip is not sealed', code: 'not_sealed' })
      let amounts
      try {
        amounts = openPayslip(await forOrg(params.orgId), item)
      } catch (e) {
        return lockedAnswer(status, e)
      }
      const logged = await recordAuditEntry({
        orgId: params.orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'payslip', entityId: params.id,
        changes: [{ field: 'sealed', oldValue: body.reason, newValue: '[REDACTED]' }],
      })
      if (!logged) return status(503, RECORD_REFUSAL)
      return { amounts }
    },
    { isSignIn: true, body: t.Object({ reason: REVEAL_REASON }) },
  )
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.payslips.create({ ...clientCreate('Payslip', body, { orgId: params.orgId }), orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'payslip', entityId: item.id, entityName: (item as any).payslipNumber })

    return { payslip: payslipView(item) }
  }, { isSignIn: true })
  .put('/:id', async ({ params, body, user, status }) => {
    const r = getRepos()
    const existing = await r.payslips.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    // A sealed slip is what a run generated. It changes with the run, never field by field.
    if ((existing as any).sealed) return status(409, { message: 'A sealed payslip cannot be edited', code: 'payslip_sealed' })
    const item = await r.payslips.updateInOrg(params.id, params.orgId, clientUpdate('Payslip', body, existing) as any, {}, { validate: true })
    if (!item) return status(404, { message: 'Not found' })

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'payslip', entityId: params.id, entityName: (item as any).payslipNumber, changes: existing ? diffChanges(existing as any, item as any) : undefined })

    return { payslip: payslipView(item) }
  }, { isSignIn: true, body: updateBody })
  .delete('/:id', async ({ params, user, status }) => {
    const r = getRepos()
    const existing = await r.payslips.findByIdInOrg(params.id, params.orgId)
    if (!existing) return status(404, { message: 'Not found' })
    await r.payslips.deleteInOrg(params.id, params.orgId)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'payslip', entityId: params.id, entityName: (existing as any)?.payslipNumber })

    return { success: true }
  }, { isSignIn: true })
