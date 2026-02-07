import type { IPayrollRun } from 'db/models'
import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

export async function generatePayrollSummaryXLSX(payrollRun: IPayrollRun): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Payroll Summary')

  // Title
  worksheet.addRow([`Payroll: ${payrollRun.name}`]).commit()
  worksheet.addRow([`Period: ${formatDate(payrollRun.period.from)} - ${formatDate(payrollRun.period.to)}`]).commit()
  worksheet.addRow([`Status: ${payrollRun.status} | Currency: ${payrollRun.currency}`]).commit()
  worksheet.addRow([]).commit()

  worksheet.columns = [
    { header: 'Employee', key: 'employee', width: 25 },
    { header: 'Base Salary', key: 'baseSalary', width: 16 },
    { header: 'Overtime Pay', key: 'overtimePay', width: 14 },
    { header: 'Bonuses', key: 'bonuses', width: 14 },
    { header: 'Allowances', key: 'allowances', width: 14 },
    { header: 'Gross Pay', key: 'grossPay', width: 16 },
    { header: 'Deductions', key: 'totalDeductions', width: 16 },
    { header: 'Net Pay', key: 'netPay', width: 16 },
    { header: 'Employer Cost', key: 'totalEmployerCost', width: 16 },
  ]

  const headerRow = worksheet.getRow(5)
  headerRow.values = ['Employee', 'Base Salary', 'Overtime Pay', 'Bonuses', 'Allowances', 'Gross Pay', 'Deductions', 'Net Pay', 'Employer Cost']
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.commit()

  for (const item of payrollRun.items) {
    worksheet.addRow({
      employee: String(item.employeeId),
      baseSalary: formatCurrency(item.baseSalary),
      overtimePay: formatCurrency(item.overtimePay),
      bonuses: formatCurrency(item.bonuses),
      allowances: formatCurrency(item.allowances),
      grossPay: formatCurrency(item.grossPay),
      totalDeductions: formatCurrency(item.totalDeductions),
      netPay: formatCurrency(item.netPay),
      totalEmployerCost: formatCurrency(item.totalEmployerCost),
    }).commit()
  }

  // Totals row
  const totalsRow = worksheet.addRow({
    employee: 'TOTALS',
    baseSalary: '',
    overtimePay: '',
    bonuses: '',
    allowances: '',
    grossPay: formatCurrency(payrollRun.totals.grossPay),
    totalDeductions: formatCurrency(payrollRun.totals.totalDeductions),
    netPay: formatCurrency(payrollRun.totals.netPay),
    totalEmployerCost: formatCurrency(payrollRun.totals.totalEmployerCost),
  })
  totalsRow.font = { bold: true }
  totalsRow.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateEmployeeCostReportXLSX(
  payrollRuns: IPayrollRun[],
  period: string,
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Employee Cost Report')

  // Title
  worksheet.addRow([`Employee Cost Report - ${period}`]).commit()
  worksheet.addRow([]).commit()

  worksheet.columns = [
    { header: 'Payroll Run', key: 'name', width: 25 },
    { header: 'Period From', key: 'from', width: 14 },
    { header: 'Period To', key: 'to', width: 14 },
    { header: 'Employees', key: 'employeeCount', width: 12 },
    { header: 'Gross Pay', key: 'grossPay', width: 18 },
    { header: 'Total Deductions', key: 'totalDeductions', width: 18 },
    { header: 'Net Pay', key: 'netPay', width: 18 },
    { header: 'Employer Cost', key: 'totalEmployerCost', width: 18 },
  ]

  const headerRow = worksheet.getRow(3)
  headerRow.values = ['Payroll Run', 'Period From', 'Period To', 'Employees', 'Gross Pay', 'Total Deductions', 'Net Pay', 'Employer Cost']
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1565C0' } }
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' }
  headerRow.commit()

  let sumGross = 0
  let sumDeductions = 0
  let sumNet = 0
  let sumEmployerCost = 0

  for (const run of payrollRuns) {
    sumGross += run.totals.grossPay
    sumDeductions += run.totals.totalDeductions
    sumNet += run.totals.netPay
    sumEmployerCost += run.totals.totalEmployerCost

    worksheet.addRow({
      name: run.name,
      from: formatDate(run.period.from),
      to: formatDate(run.period.to),
      employeeCount: run.totals.employeeCount,
      grossPay: formatCurrency(run.totals.grossPay),
      totalDeductions: formatCurrency(run.totals.totalDeductions),
      netPay: formatCurrency(run.totals.netPay),
      totalEmployerCost: formatCurrency(run.totals.totalEmployerCost),
    }).commit()
  }

  // Totals row
  const totalsRow = worksheet.addRow({
    name: 'TOTALS',
    from: '',
    to: '',
    employeeCount: '',
    grossPay: formatCurrency(sumGross),
    totalDeductions: formatCurrency(sumDeductions),
    netPay: formatCurrency(sumNet),
    totalEmployerCost: formatCurrency(sumEmployerCost),
  })
  totalsRow.font = { bold: true }
  totalsRow.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
