import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'

export const payrollRunController = new Elysia({ prefix: '/org/:orgId/payroll/run' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.payrollRuns.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { payrollRuns: result.items, ...result }
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

      return { payrollRun: run }
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

    return { payrollRun: run }
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

      const updated = await r.payrollRuns.update(id, body as any)

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (updated as any).name, changes: diffChanges(existing as any, updated as any) })

      return { payrollRun: updated }
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
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'draft') return status(400, { message: 'Can only delete draft payroll runs' })

    await r.payrollRuns.delete(id)

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

    const empResult = await r.employees.findAll({ orgId, status: 'active' }, { page: 0, size: 10000 })
    const employees = empResult.items

    const items = employees.map((emp: any) => {
      const baseSalary = emp.salary.baseSalary
      const grossPay = baseSalary
      const deductions = emp.deductions || []
      const totalDeductions = deductions.reduce((sum: number, d: any) => {
        return sum + (d.amount || (d.percentage ? baseSalary * d.percentage / 100 : 0))
      }, 0)
      const netPay = grossPay - totalDeductions
      const totalEmployerCost = grossPay

      return {
        employeeId: emp.id,
        baseSalary,
        overtimeHours: 0,
        overtimePay: 0,
        bonuses: 0,
        allowances: 0,
        grossPay,
        deductions: deductions.map((d: any) => ({
          type: d.type,
          name: d.name,
          amount: d.amount || (d.percentage ? baseSalary * d.percentage / 100 : 0),
        })),
        totalDeductions,
        netPay,
        employerContributions: [],
        totalEmployerCost,
      }
    })

    const totals = {
      grossPay: items.reduce((s: number, i: any) => s + i.grossPay, 0),
      totalDeductions: items.reduce((s: number, i: any) => s + i.totalDeductions, 0),
      netPay: items.reduce((s: number, i: any) => s + i.netPay, 0),
      totalEmployerCost: items.reduce((s: number, i: any) => s + i.totalEmployerCost, 0),
      employeeCount: items.length,
    }

    const updatedRun = await r.payrollRuns.update(id, {
      items,
      totals,
      status: 'calculated',
    } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'calculate', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: updatedRun }
  }, { isSignIn: true })
  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })
    const r = getRepos()

    const run = await r.payrollRuns.findOne({ id, orgId } as any)
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'calculated')
      return status(400, { message: 'Payroll run must be calculated first' })

    const updatedRun = await r.payrollRuns.update(id, {
      status: 'approved',
      approvedBy: user.id,
      approvedAt: new Date(),
    } as any)

    createAuditEntry({ orgId, userId: user.id, action: 'approve', module: 'payroll', entityType: 'payroll_run', entityId: id, entityName: (run as any).name })

    return { payrollRun: updatedRun }
  }, { isSignIn: true })
