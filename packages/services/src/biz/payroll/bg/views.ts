/**
 * FR-25 §3.12: what a route may send of a payroll document. Lists of what is allowed, as
 * `employeeView` is: a field added to a model stays out of every response until someone adds it here,
 * and a sealed value never leaves, not even as ciphertext. Import-pure.
 */
const plain = (doc: any) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc)

function pick(source: any, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

const CONTRACT_KEYS = [
  '_id', 'id', 'orgId', 'employeeId', 'number', 'date', 'type', 'ekatte', 'startDate', 'endDate', 'position', 'nkpd', 'kid', 'activityKid',
  'laborCategory', 'qualificationGroup', 'mainActivityRow', 'socialSecurityType', 'healthSecurityType', 'hoursPerDay',
  'daysPerWeek', 'statutoryHours', 'payKind', 'currency', 'annualLeaveDays', 'classPercent', 'experienceAtStart',
  'amendments', 'termination', 'source', 'createdAt', 'updatedAt',
] as const

export function contractView(doc: any): any {
  if (!doc) return doc
  const source = plain(doc)
  return { ...pick(source, CONTRACT_KEYS), hasPay: !!source.pay }
}

const ABSENCE_KEYS = ['_id', 'id', 'orgId', 'employeeId', 'contractId', 'from', 'to', 'workingDays', 'createdAt', 'updatedAt'] as const

export function absenceView(doc: any): any {
  if (!doc) return doc
  const source = plain(doc)
  return { ...pick(source, ABSENCE_KEYS), hasDetail: !!source.detail }
}

const LEAVE_KEYS = ['_id', 'id', 'orgId', 'employeeId', 'year', 'entitled', 'carried', 'taken', 'createdAt', 'updatedAt'] as const

export const leaveBalanceView = (doc: any): any => (doc ? pick(plain(doc), LEAVE_KEYS) : doc)

const PAYSLIP_KEYS = [
  '_id', 'id', 'orgId', 'payrollRunId', 'employeeId', 'period', 'earnings', 'deductions', 'grossPay', 'totalDeductions',
  'netPay', 'yearToDate', 'paymentMethod', 'paymentReference', 'status', 'sentAt', 'paidAt', 'engine', 'createdAt', 'updatedAt',
] as const

export function payslipView(doc: any): any {
  if (!doc) return doc
  const source = plain(doc)
  return { ...pick(source, PAYSLIP_KEYS), ...(source.sealed ? { hasSealedAmounts: true } : {}) }
}

const RUN_KEYS = [
  '_id', 'id', 'orgId', 'name', 'period', 'status', 'currency', 'totals', 'engine', 'periodCode', 'kind', 'source', 'ledger',
  'parametersAsOf', 'fileVersion', 'journalEntryId', 'approvedBy', 'approvedAt', 'paidAt', 'createdBy', 'createdAt', 'updatedAt',
] as const

/**
 * FR-25 §3.11: `payroll.read` is a run's totals. Without `payroll.personal` a run answers no line of
 * anyone's, under any engine. With it, a generic run keeps its `items` as it always had, and a
 * Bulgarian one says who is on it: their amounts need a reveal, which is audit-logged.
 */
export function runView(doc: any, personal: boolean): any {
  if (!doc) return doc
  const source = plain(doc)
  const out: any = pick(source, RUN_KEYS)
  if (source.filed) out.hasFiled = true
  if (!personal) return out
  if (source.items?.length) out.items = source.items
  if (source.sealedItems?.length) out.people = source.sealedItems.map((i: any) => ({ employeeId: i.employeeId, contractId: i.contractId }))
  return out
}
