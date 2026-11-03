import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { config } from 'config'
import { createAuditEntry, diffChanges, recordAuditEntry } from 'services/biz/audit-log.service'
import { approvePayroll, calculatePayroll, PayrollRunRefusedError } from 'services/biz/payroll.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { holdsPersonal } from 'services/biz/route-permission'
import { emitImportedDeclaration } from 'services/biz/payroll/bg/import.service'
import { openRunItems, runDocument } from 'services/biz/payroll/bg/run.service'
import { runView } from 'services/biz/payroll/bg/views'
import { PERSONAL_REFUSAL, RECORD_REFUSAL, REVEAL_REASON, payrollAnswer } from './answers.js'

const DaysBody = t.Object({
  worked: t.Number({ minimum: 0 }),
  paidLeave: t.Number({ minimum: 0 }),
  incapacity: t.Number({ minimum: 0 }),
  childcare: t.Number({ minimum: 0 }),
  uncontributed: t.Number({ minimum: 0 }),
  unpaidLeave: t.Number({ minimum: 0 }),
  employerSick: t.Number({ minimum: 0 }),
})

/** FR-25 §6.4: what one person's month takes that is not derived: day codes and one-off amounts. */
const MonthInputBody = t.Object({
  employeeId: t.String({ minLength: 24, maxLength: 24 }),
  contractId: t.Optional(t.String({ minLength: 24, maxLength: 24 })),
  days: t.Optional(DaysBody),
  earnings: t.Optional(t.Array(t.Object({
    code: t.String({ minLength: 1 }),
    amount: t.Number(),
    insurable: t.Optional(t.Boolean()),
    taxable: t.Optional(t.Boolean()),
  }))),
  leaveDailyBase: t.Optional(t.Number({ minimum: 0 })),
  annualTaxCorrection: t.Optional(t.Number()),
  advancePaid: t.Optional(t.Number({ minimum: 0 })),
  paidCash: t.Optional(t.Number({ minimum: 0 })),
})

export const payrollRunController = new Elysia({ prefix: '/org/:orgId/payroll/run' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      const searchFilter = buildSearchFilter(query.search as string, ['name', 'period'])
      Object.assign(filter, searchFilter)
    }
    if (query.status) filter.status = query.status

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.payrollRuns.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    // FR-25 §3.11: `payroll.read` is a run's totals. No line of anyone's without `payroll.personal`.
    const items = result.items.map(run => runView(run, holdsPersonal(user)))
    return { ...result, payrollRuns: items, items }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const run = await r.payrollRuns.create({
        ...body,
        orgId,
        status: 'draft',
        createdBy: user.id,
        totals: { grossPay: 0, totalDeductions: 0, netPay: 0, totalEmployerCost: 0, employeeCount: 0 },
      } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'payroll', entityType: 'payroll_run', entityId: run.id, entityName: (run as any).name })

      return { payrollRun: runView(run, holdsPersonal(user)) }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1 }),
        period: t.Object({
          from: t.String(),
          to: t.String(),
        }),
        currency: t.String(),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })

    return { payrollRun: runView(run, holdsPersonal(user)) }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const existing = await r.payrollRuns.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Payroll run not found' })
      if (!['draft', 'calculated'].includes(existing.status))
        return status(400, { message: 'Can only edit draft or calculated payroll runs' })

      const updated = await r.payrollRuns.updateInOrg(id, orgId, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (updated as any).name, changes: diffChanges(existing as any, updated as any) })

      return { payrollRun: runView(updated, holdsPersonal(user)) }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.Optional(t.String()),
        period: t.Optional(t.Object({
          from: t.String(),
          to: t.String(),
        })),
        currency: t.Optional(t.String()),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'draft') return status(400, { message: 'Can only delete draft payroll runs' })

    await r.payrollRuns.deleteInOrg(id, orgId)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { message: 'Payroll run deleted' }
  }, { isSignIn: true })
  .post('/:id/calculate', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (!['draft', 'calculated'].includes(run.status))
      return status(400, { message: 'Cannot calculate this payroll run' })

    // FR-25 §6.4: under the Bulgarian engine this reads and seals one person at a time.
    const org = await r.orgs.findById(orgId)
    if (org?.settings?.payroll?.engine === 'bg' && !holdsPersonal(user)) return status(403, PERSONAL_REFUSAL)

    let updatedRun
    try {
      updatedRun = await calculatePayroll(id, undefined, { inputs: body?.inputs })
    } catch (err) {
      if (err instanceof PayrollRunRefusedError) return status(400, { message: err.message })
      return payrollAnswer(status, err)
    }

    createAuditEntry({ orgId, userId: user.id, action: 'calculate', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: runView(updatedRun, holdsPersonal(user)) }
  }, { isSignIn: true, body: t.Optional(t.Object({ inputs: t.Optional(t.Array(MonthInputBody)) })) })
  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'calculated')
      return status(400, { message: 'Payroll run must be calculated first' })

    let updatedRun
    try {
      updatedRun = await approvePayroll(id, user.id)
    } catch (err) {
      if (err instanceof PayrollRunRefusedError) return status(400, { message: err.message })
      return payrollAnswer(status, err)
    }

    createAuditEntry({ orgId, userId: user.id, action: 'approve', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: runView(updatedRun, holdsPersonal(user)) }
  }, { isSignIn: true })
  // FR-25 §3.12: one person's month on a Bulgarian run is sealed, and this is how a person reads it.
  // The route rule needs `payroll.personal`. ⚠ The audit row is written first, and no row means no value.
  .post(
    '/:id/reveal',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const run: any = await runDocument(orgId, id).catch(() => null)
      if (!run) return status(404, { message: 'Payroll run not found' })

      let items
      try {
        items = await openRunItems(orgId, run, body.employeeIds)
      } catch (e) {
        return payrollAnswer(status, e)
      }

      const logged = await recordAuditEntry({
        orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: run.name,
        changes: items.map((item: any) => ({ field: `items.${item.employeeId}`, oldValue: body.reason, newValue: '[REDACTED]' })),
      })
      if (!logged) return status(503, RECORD_REFUSAL)

      return { items }
    },
    {
      isSignIn: true,
      body: t.Object({ employeeIds: t.Optional(t.Array(t.String())), reason: REVEAL_REASON }),
    },
  )
  // FR-25 §5.1's gate: the file of an imported month, emitted again from what is stored. A file full of
  // ЕГН numbers, so a read like the one above.
  .post(
    '/:id/declaration',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const run: any = await runDocument(orgId, id).catch(() => null)
      if (!run) return status(404, { message: 'Payroll run not found' })
      if (run.source !== 'imported') return status(422, { message: 'Only an imported month holds its filed rows', code: 'not_imported' })
      if (body.form === 'nra' && !run.filed) return status(404, { message: 'This month holds no обр. 6', code: 'no_filed_nra' })

      let bytes
      try {
        bytes = await emitImportedDeclaration(orgId, run, body.form, config.payroll.developerEik)
      } catch (e) {
        return payrollAnswer(status, e)
      }

      const logged = await recordAuditEntry({
        orgId, userId: user.id, action: 'reveal', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: run.name,
        changes: [{ field: `declaration.${body.form}`, oldValue: body.reason, newValue: '[REDACTED]' }],
      })
      if (!logged) return status(503, RECORD_REFUSAL)

      return { contentBase64: Buffer.from(bytes).toString('base64') }
    },
    {
      isSignIn: true,
      body: t.Object({ form: t.Union([t.Literal('empl'), t.Literal('nra')]), reason: REVEAL_REASON }),
    },
  )
