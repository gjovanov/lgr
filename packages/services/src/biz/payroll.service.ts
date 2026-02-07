import { Employee, PayrollRun, Payslip, Org, type IPayrollRun } from 'db/models'
import { logger } from '../logger/logger.js'

export async function calculatePayroll(payrollRunId: string): Promise<IPayrollRun> {
  const run = await PayrollRun.findById(payrollRunId)
  if (!run) throw new Error('Payroll run not found')
  if (run.status !== 'draft') throw new Error('Only draft payroll runs can be calculated')

  const orgId = String(run.orgId)
  const org = await Org.findById(orgId)
  if (!org) throw new Error('Organization not found')

  const employees = await Employee.find({ orgId, status: 'active' }).exec()
  const payrollConfig = org.settings.payroll

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
    for (const ded of emp.deductions) {
      const amount = ded.amount || (ded.percentage ? grossPay * ded.percentage / 100 : 0)
      deductions.push({ type: ded.type, name: ded.name, amount })
    }
    const totalDed = deductions.reduce((sum, d) => sum + d.amount, 0)
    const netPay = grossPay - totalDed

    // Employer contributions
    const employerContributions = [
      { type: 'social_security', name: 'Social Security', amount: grossPay * payrollConfig.socialSecurityRate / 100 },
      { type: 'health_insurance', name: 'Health Insurance', amount: grossPay * payrollConfig.healthInsuranceRate / 100 },
      { type: 'pension', name: 'Pension Fund', amount: grossPay * payrollConfig.pensionRate / 100 },
    ].filter(c => c.amount > 0)
    const employerTotal = grossPay + employerContributions.reduce((sum, c) => sum + c.amount, 0)

    items.push({
      employeeId: emp._id,
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

  run.items = items
  run.totals = {
    grossPay: totalGross,
    totalDeductions,
    netPay: totalNet,
    totalEmployerCost,
    employeeCount: employees.length,
  }
  run.status = 'calculated'
  await run.save()

  logger.info({ payrollRunId, employeeCount: employees.length }, 'Payroll calculated')
  return run
}

export async function approvePayroll(payrollRunId: string, userId: string): Promise<IPayrollRun> {
  const run = await PayrollRun.findById(payrollRunId)
  if (!run) throw new Error('Payroll run not found')
  if (run.status !== 'calculated') throw new Error('Only calculated payroll runs can be approved')

  run.status = 'approved'
  run.approvedBy = userId as any
  run.approvedAt = new Date()
  await run.save()

  // Generate payslips
  for (const item of run.items) {
    await Payslip.create({
      orgId: run.orgId,
      payrollRunId: run._id,
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
    })
  }

  logger.info({ payrollRunId }, 'Payroll approved and payslips generated')
  return run
}
