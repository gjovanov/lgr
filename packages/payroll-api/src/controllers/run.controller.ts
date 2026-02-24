import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { PayrollRun, Employee } from 'db/models'

export const payrollRunController = new Elysia({ prefix: '/org/:orgId/payroll/run' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status

    const page = Number(query.page) || 1
    const pageSize = Number(query.pageSize) || 50
    const skip = (page - 1) * pageSize

    const [data, total] = await Promise.all([
      PayrollRun.find(filter).sort({ 'period.from': -1 }).skip(skip).limit(pageSize).exec(),
      PayrollRun.countDocuments(filter).exec(),
    ])

    return { payrollRuns: data, data, total, page, pageSize, totalPages: Math.ceil(total / pageSize) }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const run = await PayrollRun.create({
        ...body,
        orgId,
        status: 'draft',
        createdBy: user.id,
        totals: { grossPay: 0, totalDeductions: 0, netPay: 0, totalEmployerCost: 0, employeeCount: 0 },
      })

      return { payrollRun: run.toJSON() }
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

    const run = await PayrollRun.findOne({ _id: id, orgId }).lean().exec()
    if (!run) return status(404, { message: 'Payroll run not found' })

    return { payrollRun: run }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      const existing = await PayrollRun.findOne({ _id: id, orgId }).exec()
      if (!existing) return status(404, { message: 'Payroll run not found' })
      if (!['draft', 'calculated'].includes(existing.status))
        return status(400, { message: 'Can only edit draft or calculated payroll runs' })

      const updated = await PayrollRun.findByIdAndUpdate(id, body, { new: true }).lean().exec()
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

    const run = await PayrollRun.findOne({ _id: id, orgId }).exec()
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'draft') return status(400, { message: 'Can only delete draft payroll runs' })

    await PayrollRun.findByIdAndDelete(id).exec()
    return { message: 'Payroll run deleted' }
  }, { isSignIn: true })
  .post('/:id/calculate', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const run = await PayrollRun.findOne({ _id: id, orgId }).exec()
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (!['draft', 'calculated'].includes(run.status))
      return status(400, { message: 'Cannot calculate this payroll run' })

    const employees = await Employee.find({ orgId, status: 'active' }).exec()

    const items = employees.map((emp) => {
      const baseSalary = emp.salary.baseSalary
      const grossPay = baseSalary
      const totalDeductions = emp.deductions.reduce((sum, d) => {
        return sum + (d.amount || (d.percentage ? baseSalary * d.percentage / 100 : 0))
      }, 0)
      const netPay = grossPay - totalDeductions
      const totalEmployerCost = grossPay

      return {
        employeeId: emp._id,
        baseSalary,
        overtimeHours: 0,
        overtimePay: 0,
        bonuses: 0,
        allowances: 0,
        grossPay,
        deductions: emp.deductions.map((d) => ({
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
      grossPay: items.reduce((s, i) => s + i.grossPay, 0),
      totalDeductions: items.reduce((s, i) => s + i.totalDeductions, 0),
      netPay: items.reduce((s, i) => s + i.netPay, 0),
      totalEmployerCost: items.reduce((s, i) => s + i.totalEmployerCost, 0),
      employeeCount: items.length,
    }

    run.items = items as any
    run.totals = totals
    run.status = 'calculated'
    await run.save()

    return { payrollRun: run.toJSON() }
  }, { isSignIn: true })
  .post('/:id/approve', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (!['admin', 'hr_manager'].includes(user.role))
      return status(403, { message: 'Admin or HR manager only' })

    const run = await PayrollRun.findOne({ _id: id, orgId }).exec()
    if (!run) return status(404, { message: 'Payroll run not found' })
    if (run.status !== 'calculated')
      return status(400, { message: 'Payroll run must be calculated first' })

    run.status = 'approved'
    run.approvedBy = user.id as any
    run.approvedAt = new Date()
    await run.save()

    return { payrollRun: run.toJSON() }
  }, { isSignIn: true })
