import { PayrollElement } from 'db/models'

/**
 * FR-25 §3.10: the lines a Bulgarian payslip is made of. `pmCodes` stay empty here: they are numbers
 * from one customer's PlusMinus, which an import fills in from that customer's own files.
 */
export const DEFAULT_PAYROLL_ELEMENTS = [
  { code: 'salary', label: 'Заплата', kind: 'earning', insurable: true, taxable: true, leaveBase: true },
  { code: 'classSupplement', label: 'ДТВ за стаж', kind: 'earning', insurable: true, taxable: true, leaveBase: true },
  { code: 'paidLeave', label: 'Платен отпуск', kind: 'earning', insurable: true, taxable: true, leaveBase: false },
  { code: 'employerSickPay', label: 'Болнични от работодателя', kind: 'earning', insurable: true, taxable: false, leaveBase: false },
  { code: 'compensation', label: 'Обезщетение', kind: 'earning', insurable: false, taxable: true, leaveBase: false },
  { code: 'bonus', label: 'Премия', kind: 'earning', insurable: true, taxable: true, leaveBase: true },
  { code: 'foodVoucher', label: 'Ваучери за храна', kind: 'earning', insurable: false, taxable: false, leaveBase: false },
] as const

/** Safe to run before every calculation: what an org has already is left as it is. */
export async function seedPayrollElements(orgId: unknown): Promise<void> {
  await PayrollElement.bulkWrite(DEFAULT_PAYROLL_ELEMENTS.map(element => ({
    updateOne: {
      filter: { orgId, code: element.code },
      update: { $setOnInsert: { ...element, orgId, pmCodes: [], isActive: true } },
      upsert: true,
    },
  })))
}
