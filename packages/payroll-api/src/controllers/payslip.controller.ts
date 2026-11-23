import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges, recordAuditEntry } from 'services/biz/audit-log.service'
import { clientCreate, clientUpdate } from 'services/biz/server-owned'
import { can } from 'services/biz/access/evaluate'
import { listSort, payslipListFilter } from 'services/biz/payroll/list-export'
import { renderPayslipPdf } from 'services/biz/payroll/payslip-pdf'
import { forOrg } from 'services/biz/personal-data/personal-data.service'
import { openPayslip, type SealedPayslip } from 'services/biz/payroll/bg/run.service'
import { payslipView } from 'services/biz/payroll/bg/views'
import { lockedAnswer, PERSONAL_REFUSAL, RECORD_REFUSAL, REVEAL_REASON } from './answers.js'
import { EXPORT_FAILED, listExport } from './list-export.js'

// A PUT never carries `orgId`: a document does not move between orgs (FR-20.7). `updateInOrg`
// drops it too; this answers 422 instead of ignoring it. What else a body may not choose (the
// fields the server sets) is refused in the handlers: `services/biz/server-owned.ts`.
// FR-32.18 (#797): a create declares its body as an object. Its values are the model's to judge: the document goes
// through `clientCreate` and the model's validators, and a value the model refuses answers 422 naming the field.
const createBody = t.Object({}, { additionalProperties: true })
const updateBody = t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })

export const payslipController = new Elysia({ prefix: '/org/:orgId/payroll/payslip' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    // #830: the one filter of this list, which its export applies too. A payslip names no person of its own: the
    // search finds the employees it is for (it looked in `employeeName`, which a payslip has not).
    const filter = await payslipListFilter(orgId, query)

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10

    const result = await r.payslips.findAll(filter, { page, size, sort: listSort(query) })
    const items = result.items.map(payslipView)
    return { ...result, payslips: items, items }
  }, { isSignIn: true })
  // #830: the list as Excel or PDF, on the list's filters: whose payslip, which month, its status. No amount, sealed
  // or not: `services/biz/payroll/list-export.ts`.
  .get('/export', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return (await listExport('payslips', orgId, query)) ?? status(500, EXPORT_FAILED)
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
  // #830: one payslip as a PDF. A payslip of the generic run prints on the list's own permission (the route rule's
  // floor, `payroll-people.view`). A sealed one (FR-25 §3.12) is a reveal: it needs `payroll.personal`
  // (`payroll-people.reveal`) and a reason, and the audit row, the one `/reveal` writes, is written before the file
  // leaves. No row, no file.
  .post(
    '/:id/pdf',
    async ({ params, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const item = await r.payslips.findByIdInOrg(params.id, params.orgId)
      if (!item) return status(404, { message: 'Not found' })

      let amounts: SealedPayslip
      if (item.sealed) {
        if (!can(user, 'payroll-people.reveal')) return status(403, PERSONAL_REFUSAL)
        if (!body.reason) return status(422, { message: 'A sealed payslip prints with a reason', code: 'reason_required' })
        try {
          amounts = openPayslip(await forOrg(params.orgId), { id: item.id, sealed: item.sealed })
        } catch (e) {
          return lockedAnswer(status, e)
        }
      } else {
        amounts = {
          earnings: item.earnings ?? [],
          deductions: item.deductions ?? [],
          grossPay: item.grossPay ?? 0,
          totalDeductions: item.totalDeductions ?? 0,
          netPay: item.netPay ?? 0,
          yearToDate: item.yearToDate ?? { grossPay: 0, totalDeductions: 0, netPay: 0 },
        }
      }

      const buffer = await renderPayslipPdf(params.orgId, item, amounts, { labels: body.labels, values: body.values })
      if (!buffer) return status(500, EXPORT_FAILED)

      if (item.sealed) {
        const logged = await recordAuditEntry({
          orgId: params.orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'payslip', entityId: params.id,
          changes: [{ field: 'sealed.pdf', oldValue: body.reason, newValue: '[REDACTED]' }],
        })
        if (!logged) return status(503, RECORD_REFUSAL)
      }

      return new Response(new Uint8Array(buffer), {
        headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="payslip-${params.id}.pdf"` },
      })
    },
    {
      isSignIn: true,
      body: t.Object({
        reason: t.Optional(REVEAL_REASON),
        labels: t.Optional(t.Record(t.String(), t.String({ maxLength: 200 }))),
        values: t.Optional(t.Record(t.String(), t.Record(t.String(), t.String({ maxLength: 200 })))),
      }),
    },
  )
  .post('/', async ({ params, body, user }) => {
    const r = getRepos()
    const item = await r.payslips.create({ ...clientCreate('Payslip', body, { orgId: params.orgId }), orgId: params.orgId } as any)

    createAuditEntry({ orgId: params.orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'payslip', entityId: item.id, entityName: (item as any).payslipNumber })

    return { payslip: payslipView(item) }
  }, { isSignIn: true, body: createBody })
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
