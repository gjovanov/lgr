import type { RepositoryRegistry } from 'dal'
import type { IPayrollRun } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { seedPayrollElements } from './payroll/bg/elements.js'
import { calculateBgRun, generateBgPayslips, runDocument, type BgMonthInput } from './payroll/bg/run.service.js'

/** The run is not in a state to do this: a person can be told why. */
export class PayrollRunRefusedError extends Error {}

/**
 * The one calculation: the `/calculate` route runs this. A calculated run can be calculated again,
 * as long as nobody has approved it: that is how a corrected salary reaches a run before it is final.
 */
export async function calculatePayroll(payrollRunId: string, repos?: RepositoryRegistry, options: { inputs?: readonly BgMonthInput[] } = {}): Promise<IPayrollRun> {
  const r = repos ?? getRepos()
  const run = await r.payrollRuns.findById(payrollRunId)
  if (!run) throw new Error('Payroll run not found')
  const calculable = ['draft', 'calculated']
  const refusal = 'Only draft or calculated payroll runs can be calculated'
  if (!calculable.includes(run.status)) throw new PayrollRunRefusedError(refusal)

  const orgId = run.orgId
  const org = await r.orgs.findById(orgId)
  if (!org) throw new Error('Organization not found')

  // FR-25 §6.4: the Bulgarian calculation, for an org that asked for it. Unset, nothing below changes.
  if (org.settings?.payroll?.engine === 'bg') {
    await seedPayrollElements(orgId)
    const { update } = await calculateBgRun(orgId, run, options.inputs)
    const calculated = await r.payrollRuns.updateInOrg(payrollRunId, orgId, update as any, { status: { $in: calculable } })
    if (!calculated) throw new PayrollRunRefusedError(refusal)
    logger.info({ payrollRunId, employeeCount: update.totals.employeeCount }, 'Payroll calculated')
    return calculated
  }

  const employees = await r.employees.findMany({ orgId, status: 'active' } as any)
  // Read without the model's defaults: an org stored before these settings existed has none.
  const payrollConfig = org.settings?.payroll

  const items: any[] = []
  let totalGross = 0
  let totalDeductions = 0
  let totalNet = 0
  let totalEmployerCost = 0

  for (const emp of employees) {
    const baseSalary = emp.salary.baseSalary
    const overtimeHours = 0 // TODO: calculate from timesheets
    const overtimePay = overtimeHours * (emp.salary.hourlyRate || baseSalary / 160) * 1.5
    const bonuses = 0
    const allowances = 0
    const grossPay = baseSalary + overtimePay + bonuses + allowances

    // Calculate deductions
    const deductions: { type: string; name: string; amount: number }[] = []
    for (const ded of emp.deductions ?? []) {
      const amount = ded.amount || (ded.percentage ? grossPay * ded.percentage / 100 : 0)
      deductions.push({ type: ded.type, name: ded.name, amount })
    }
    const totalDed = deductions.reduce((sum, d) => sum + d.amount, 0)
    const netPay = grossPay - totalDed

    // Employer contributions
    const employerContributions = [
      { type: 'social_security', name: 'Social Security', amount: grossPay * (payrollConfig?.socialSecurityRate || 0) / 100 },
      { type: 'health_insurance', name: 'Health Insurance', amount: grossPay * (payrollConfig?.healthInsuranceRate || 0) / 100 },
      { type: 'pension', name: 'Pension Fund', amount: grossPay * (payrollConfig?.pensionRate || 0) / 100 },
    ].filter(c => c.amount > 0)
    const employerTotal = grossPay + employerContributions.reduce((sum, c) => sum + c.amount, 0)

    items.push({
      employeeId: emp.id,
      baseSalary,
      overtimeHours,
      overtimePay,
      bonuses,
      allowances,
      grossPay,
      deductions,
      totalDeductions: totalDed,
      netPay,
      employerContributions,
      totalEmployerCost: employerTotal,
    })

    totalGross += grossPay
    totalDeductions += totalDed
    totalNet += netPay
    totalEmployerCost += employerTotal
  }

  // Only while it can still be calculated: an approval that got in first keeps what it approved.
  const updated = await r.payrollRuns.updateInOrg(payrollRunId, orgId, {
    items,
    totals: {
      grossPay: totalGross,
      totalDeductions,
      netPay: totalNet,
      totalEmployerCost,
      employeeCount: employees.length,
    },
    status: 'calculated',
  } as any, { status: { $in: calculable } })
  if (!updated) throw new PayrollRunRefusedError(refusal)

  logger.info({ payrollRunId, employeeCount: employees.length }, 'Payroll calculated')
  return updated
}

export async function approvePayroll(payrollRunId: string, userId: string, repos?: RepositoryRegistry): Promise<IPayrollRun> {
  const r = repos ?? getRepos()
  const run = await r.payrollRuns.findById(payrollRunId)
  if (!run) throw new Error('Payroll run not found')
  if (run.status !== 'calculated') throw new PayrollRunRefusedError('Only calculated payroll runs can be approved')

  // Claimed before the payslips: of two approvals at once, one makes them and the other is refused.
  const updated = await r.payrollRuns.updateInOrg(payrollRunId, run.orgId, {
    status: 'approved',
    approvedBy: userId,
    approvedAt: new Date(),
  } as any, { status: 'calculated' })
  if (!updated) throw new PayrollRunRefusedError('Only calculated payroll runs can be approved')

  // Generate payslips: one write, however many people the run pays.
  try {
    // FR-25 §3.10: under `bg` a payslip is sealed, from the run's sealed lines.
    if (updated.engine === 'bg') await generateBgPayslips(run.orgId, await runDocument(run.orgId, payrollRunId))
    else await r.payslips.createMany(updated.items.map((item) => ({
      orgId: run.orgId,
      payrollRunId: run.id,
      employeeId: item.employeeId,
      period: run.period,
      earnings: [
        { type: 'base_salary', description: 'Base Salary', amount: item.baseSalary },
        ...(item.overtimePay > 0
          ? [{ type: 'overtime', description: 'Overtime', amount: item.overtimePay, hours: item.overtimeHours }]
          : []),
      ],
      deductions: item.deductions.map((d: any) => ({ type: d.type, description: d.name || d.description, amount: d.amount })),
      grossPay: item.grossPay,
      totalDeductions: item.totalDeductions,
      netPay: item.netPay,
      yearToDate: { grossPay: item.grossPay, totalDeductions: item.totalDeductions, netPay: item.netPay },
      paymentMethod: 'bank_transfer',
      status: 'generated',
    })) as any)
  } catch (err) {
    // A run approved with no payslips could never be approved again. It goes back, whole.
    await r.payslips.deleteMany({ orgId: run.orgId, payrollRunId: run.id } as any)
    await r.payrollRuns.updateInOrg(payrollRunId, run.orgId, { status: 'calculated', approvedBy: null, approvedAt: null } as any, { status: 'approved' })
    throw err
  }

  logger.info({ payrollRunId }, 'Payroll approved and payslips generated')
  return updated
}
