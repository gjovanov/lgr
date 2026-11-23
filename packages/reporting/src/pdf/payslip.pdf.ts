import { markdownToPdf, mdText, fmtDate } from './base.pdf.js'

/**
 * One person's payslip as a PDF (#830), printed by the shared renderer every markdown form uses.
 *
 * It takes the payslip as plain data, already opened: under the Bulgarian engine the amounts are sealed (FR-25 §3.12),
 * and the route that calls this has checked `payroll.personal` and written the audit row first. ⚠ It prints nothing of
 * the employee's sealed record: no ЕГН, no tax number, no bank account. Name, number, department, position and the kind
 * of employment are what a payslip needs to say whose it is.
 *
 * The words arrive from the screen in the reader's language (`labels`), as the report exports' headers do; a missing
 * one is English.
 */

export interface PayslipPdfLine {
  type: string
  description: string
  amount: number
  hours?: number
  rate?: number
}

export interface PayslipPdfData {
  orgName: string
  employee: { name: string; number?: string; department?: string; position?: string; employmentType?: string }
  period: { from?: Date | string; to?: Date | string }
  earnings: PayslipPdfLine[]
  deductions: PayslipPdfLine[]
  grossPay: number
  totalDeductions: number
  netPay: number
  yearToDate?: { grossPay: number; totalDeductions: number; netPay: number }
  paymentMethod?: string
  paymentReference?: string
  currency?: string
}

export const PAYSLIP_PDF_LABELS = {
  title: 'Payslip',
  organization: 'Organization',
  period: 'Period',
  employeeDetails: 'Employee',
  name: 'Name',
  employeeNumber: 'Employee number',
  department: 'Department',
  position: 'Position',
  employmentType: 'Employment type',
  earnings: 'Earnings',
  deductions: 'Deductions',
  type: 'Type',
  description: 'Description',
  amount: 'Amount',
  grossPay: 'Gross pay',
  totalDeductions: 'Total deductions',
  netPay: 'Net pay',
  paymentMethod: 'Payment method',
  reference: 'Reference',
  yearToDate: 'Year to date',
  footnote: 'This is a computer-generated document and does not require a signature.',
}

export type PayslipPdfLabels = typeof PAYSLIP_PDF_LABELS

/** The labels the screen sent, each a string, over the English ones; anything else is ignored. */
export function payslipLabels(sent: Record<string, unknown> | undefined): PayslipPdfLabels {
  const out: PayslipPdfLabels = { ...PAYSLIP_PDF_LABELS }
  for (const key of Object.keys(out) as (keyof PayslipPdfLabels)[]) {
    const v = sent?.[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.slice(0, 200)
  }
  return out
}

const money = (n: number | undefined) => (Number(n) || 0).toFixed(2)

/** The markdown the PDF is printed from. Exported so what it says can be asserted without Chrome. */
export function buildPayslipMarkdown(data: PayslipPdfData, labels: PayslipPdfLabels = PAYSLIP_PDF_LABELS): string {
  const cur = data.currency ? ` (${mdText(data.currency)})` : ''
  const L = (key: keyof PayslipPdfLabels) => mdText(labels[key])

  let md = `# ${L('title')}\n\n`
  md += `**${L('organization')}:** ${mdText(data.orgName)}\n\n`
  md += `**${L('period')}:** ${mdText(`${fmtDate(data.period.from)} – ${fmtDate(data.period.to)}`)}\n\n---\n\n`

  md += `## ${L('employeeDetails')}\n\n| | |\n|---|---|\n`
  md += `| **${L('name')}** | ${mdText(data.employee.name)} |\n`
  if (data.employee.number) md += `| **${L('employeeNumber')}** | ${mdText(data.employee.number)} |\n`
  if (data.employee.department) md += `| **${L('department')}** | ${mdText(data.employee.department)} |\n`
  if (data.employee.position) md += `| **${L('position')}** | ${mdText(data.employee.position)} |\n`
  if (data.employee.employmentType) md += `| **${L('employmentType')}** | ${mdText(data.employee.employmentType)} |\n`
  md += `\n---\n\n`

  md += `## ${L('earnings')}\n\n| ${L('type')} | ${L('description')} | ${L('amount')}${cur} |\n|------|-------------|-------:|\n`
  for (const e of data.earnings) {
    const detail = e.hours && e.rate ? `${e.description} (${e.hours}h x ${money(e.rate)})` : e.description
    md += `| ${mdText(e.type)} | ${mdText(detail)} | ${money(e.amount)} |\n`
  }
  md += `| | **${L('grossPay')}** | **${money(data.grossPay)}** |\n\n---\n\n`

  md += `## ${L('deductions')}\n\n| ${L('type')} | ${L('description')} | ${L('amount')}${cur} |\n|------|-------------|-------:|\n`
  for (const d of data.deductions) md += `| ${mdText(d.type)} | ${mdText(d.description)} | ${money(d.amount)} |\n`
  md += `| | **${L('totalDeductions')}** | **${money(data.totalDeductions)}** |\n\n---\n\n`

  md += `## ${L('netPay')}\n\n| | ${L('amount')}${cur} |\n|---|-------:|\n`
  md += `| ${L('grossPay')} | ${money(data.grossPay)} |\n`
  md += `| ${L('totalDeductions')} | -${money(data.totalDeductions)} |\n`
  md += `| **${L('netPay')}** | **${money(data.netPay)}** |\n\n`

  if (data.paymentMethod) md += `**${L('paymentMethod')}:** ${mdText(data.paymentMethod)}\n\n`
  if (data.paymentReference) md += `**${L('reference')}:** ${mdText(data.paymentReference)}\n\n`

  if (data.yearToDate) {
    md += `---\n\n## ${L('yearToDate')}\n\n| | ${L('amount')}${cur} |\n|---|-------:|\n`
    md += `| ${L('grossPay')} | ${money(data.yearToDate.grossPay)} |\n`
    md += `| ${L('totalDeductions')} | ${money(data.yearToDate.totalDeductions)} |\n`
    md += `| ${L('netPay')} | ${money(data.yearToDate.netPay)} |\n`
  }

  md += `\n---\n\n*${L('footnote')}*\n`
  return md
}

export async function generatePayslipPDF(data: PayslipPdfData, labels?: PayslipPdfLabels): Promise<Buffer | undefined> {
  return markdownToPdf(buildPayslipMarkdown(data, labels))
}
