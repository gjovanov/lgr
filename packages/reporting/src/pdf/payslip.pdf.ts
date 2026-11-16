import type { IPayslip, IEmployee, IOrg } from 'db/models'
import { markdownToPdf, buildHeader, mdText } from './base.pdf.js'

export async function generatePayslipPDF(
  payslip: IPayslip,
  employee: IEmployee,
  org: IOrg,
): Promise<Buffer | undefined> {
  let md = buildHeader(
    'Payslip',
    org.name,
    `${payslip.period.from.toLocaleDateString()} - ${payslip.period.to.toLocaleDateString()}`,
  )

  // Employee details
  md += `## Employee Details\n\n`
  md += `| | |\n`
  md += `|---|---|\n`
  md += `| **Name** | ${mdText([employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(' '))} |\n`
  md += `| **Employee #** | ${mdText(employee.employeeNumber)} |\n`
  md += `| **Department** | ${mdText(employee.department)} |\n`
  md += `| **Position** | ${mdText(employee.position)} |\n`
  md += `| **Employment Type** | ${mdText(employee.employmentType)} |\n`
  if (employee.taxId) md += `| **Tax ID** | ${mdText(employee.taxId)} |\n`

  md += `\n---\n\n`

  // Earnings
  md += `## Earnings\n\n`
  md += `| Type | Description | Amount |\n`
  md += `|------|-------------|-------:|\n`

  for (const earning of payslip.earnings) {
    let detail = earning.description
    if (earning.hours && earning.rate) {
      detail += ` (${earning.hours}h x ${earning.rate.toFixed(2)})`
    }
    md += `| ${mdText(earning.type)} | ${mdText(detail)} | ${earning.amount.toFixed(2)} |\n`
  }

  md += `| | **Gross Pay** | **${payslip.grossPay.toFixed(2)}** |\n`

  md += `\n---\n\n`

  // Deductions
  md += `## Deductions\n\n`
  md += `| Type | Description | Amount |\n`
  md += `|------|-------------|-------:|\n`

  for (const deduction of payslip.deductions) {
    md += `| ${mdText(deduction.type)} | ${mdText(deduction.description)} | ${deduction.amount.toFixed(2)} |\n`
  }

  md += `| | **Total Deductions** | **${payslip.totalDeductions.toFixed(2)}** |\n`

  md += `\n---\n\n`

  // Net Pay
  md += `## Net Pay\n\n`
  md += `| | Amount |\n`
  md += `|---|-------:|\n`
  md += `| Gross Pay | ${payslip.grossPay.toFixed(2)} |\n`
  md += `| Total Deductions | -${payslip.totalDeductions.toFixed(2)} |\n`
  md += `| **Net Pay** | **${payslip.netPay.toFixed(2)}** |\n`

  md += `\n`

  // Payment info
  md += `**Payment Method:** ${mdText(payslip.paymentMethod)}\n\n`
  if (payslip.paymentReference) {
    md += `**Reference:** ${mdText(payslip.paymentReference)}\n\n`
  }

  // Year-to-date
  if (payslip.yearToDate) {
    md += `---\n\n## Year-to-Date\n\n`
    md += `| | Amount |\n`
    md += `|---|-------:|\n`
    md += `| Gross Pay | ${payslip.yearToDate.grossPay.toFixed(2)} |\n`
    md += `| Total Deductions | ${payslip.yearToDate.totalDeductions.toFixed(2)} |\n`
    md += `| Net Pay | ${payslip.yearToDate.netPay.toFixed(2)} |\n`
  }

  md += `\n---\n\n*This is a computer-generated document and does not require a signature.*\n`

  return markdownToPdf(md)
}
