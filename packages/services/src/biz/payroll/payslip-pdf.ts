import { Employee, Org, PayrollRun } from 'db/models'
import { generatePayslipPDF, payslipLabels } from 'reporting/pdf/payslip.pdf'
import type { SealedPayslip } from './bg/run.service.js'

/**
 * #830: one payslip as a PDF. The route decides who may and opens a sealed payslip first (FR-25 §3.12: it needs
 * `payroll.personal`, and the audit row is the route's); this puts the amounts it is handed beside who the payslip is
 * for and prints them.
 *
 * ⚠ Of the employee, only what says whose payslip it is: name, number, department, position, kind of employment. The
 * sealed record (ЕГН, tax number, bank account, address) is never opened here.
 */

export interface PayslipForPdf {
  employeeId?: unknown
  payrollRunId?: unknown
  period?: { from?: Date | string; to?: Date | string }
  paymentMethod?: string
  paymentReference?: string
}

export interface PayslipPdfRequest {
  /** The screen's words for the sheet, by `PAYSLIP_PDF_LABELS` key. */
  labels?: Record<string, unknown>
  /** Stored value → the screen's word, for the payment method and the kind of employment. */
  values?: Record<string, Record<string, unknown>>
}

const wordOf = (map: Record<string, unknown> | undefined, value: string | undefined): string | undefined => {
  if (!value) return value
  const w = map?.[value]
  return typeof w === 'string' && w.trim() ? w.slice(0, 200) : value
}

export async function renderPayslipPdf(orgId: string, slip: PayslipForPdf, amounts: SealedPayslip, request: PayslipPdfRequest = {}): Promise<Buffer | undefined> {
  const [org, employee, run] = await Promise.all([
    Org.findById(orgId, { name: 1 }).lean().exec(),
    slip.employeeId
      ? Employee.findOne({ _id: slip.employeeId, orgId }, { firstName: 1, middleName: 1, lastName: 1, employeeNumber: 1, department: 1, position: 1, employmentType: 1 }).lean().exec()
      : null,
    slip.payrollRunId ? PayrollRun.findOne({ _id: slip.payrollRunId, orgId }, { currency: 1 }).lean().exec() : null,
  ])

  return generatePayslipPDF({
    orgName: org?.name ?? '',
    employee: {
      name: employee ? [employee.firstName, employee.middleName, employee.lastName].filter(Boolean).join(' ') : '',
      number: employee?.employeeNumber,
      department: employee?.department,
      position: employee?.position,
      employmentType: wordOf(request.values?.employmentType, employee?.employmentType),
    },
    period: { from: slip.period?.from, to: slip.period?.to },
    earnings: amounts.earnings ?? [],
    deductions: amounts.deductions ?? [],
    grossPay: amounts.grossPay ?? 0,
    totalDeductions: amounts.totalDeductions ?? 0,
    netPay: amounts.netPay ?? 0,
    yearToDate: amounts.yearToDate,
    paymentMethod: wordOf(request.values?.paymentMethod, slip.paymentMethod),
    paymentReference: slip.paymentReference,
    currency: run?.currency,
  }, payslipLabels(request.labels))
}
