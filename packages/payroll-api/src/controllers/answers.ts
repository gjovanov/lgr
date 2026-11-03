import { PersonalDataLockedError } from 'services/biz/personal-data/personal-data.service'
import { UnsupportedPayrollCaseError } from 'services/biz/payroll/bg/engine'
import { PayrollParameterMissingError } from 'services/biz/payroll/bg/parameters'
import { DeveloperEikMissingError } from 'services/biz/payroll/bg/import.service'

/** FR-25 §3.12: a missing or wrong key is a 503 with a name, never a blank. Anything else is a bug. */
export function lockedAnswer(status: any, e: unknown) {
  if (e instanceof PersonalDataLockedError) return status(e.statusCode, { message: e.message, code: e.code })
  throw e
}

/** And what the payroll engine refuses, by name. Those messages name a number and a period, no person. */
export function payrollAnswer(status: any, e: unknown) {
  if (e instanceof UnsupportedPayrollCaseError || e instanceof PayrollParameterMissingError || e instanceof DeveloperEikMissingError) {
    return status(e.statusCode, { message: e.message, code: e.code })
  }
  return lockedAnswer(status, e)
}

export const PERSONAL_REFUSAL = { message: 'Permission required: payroll.personal', code: 'permission_required' }
