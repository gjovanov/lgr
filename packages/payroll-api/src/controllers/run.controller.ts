import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { approvePayroll, calculatePayroll, PayrollRunRefusedError } from 'services/biz/payroll.service'
import { holdsPersonal } from 'services/biz/route-permission'
import { buildSearchFilter } from 'services/biz/search.utils'

/** FR-25 §3.11: `payroll.read` is a run's totals. Its `items` are one person each. */
function runView<T extends object>(run: T, user: Parameters<typeof holdsPersonal>[0]) {
  if (holdsPersonal(user)) return run
  const { items: _people, ...totals } = run as T & { items?: unknown }
  return totals
}

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
    const items = result.items.map(item => runView(item, user))
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

      return { payrollRun: runView(run, user) }
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

    return { payrollRun: runView(run, user) }
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

      return { payrollRun: runView(updated as object, user) }
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
  .post('/:id/calculate', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (!['draft', 'calculated'].includes(run.status))
      return status(400, { message: 'Cannot calculate this payroll run' })

    let updatedRun
    try {
      updatedRun = await calculatePayroll(id)
    } catch (err) {
      if (err instanceof PayrollRunRefusedError) return status(400, { message: err.message })
      throw err
    }

    createAuditEntry({ orgId, userId: user.id, action: 'calculate', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: runView(updatedRun, user) }
  }, { isSignIn: true })
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
      throw err
    }

    createAuditEntry({ orgId, userId: user.id, action: 'approve', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: runView(updatedRun, user) }
  }, { isSignIn: true })
