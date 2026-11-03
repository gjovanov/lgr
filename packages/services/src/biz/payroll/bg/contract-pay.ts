import { forOrg } from '../../personal-data/personal-data.service.js'

/**
 * FR-25 §3.12: what is sensitive about a contract, in one sealed JSON on `EmploymentContract.pay`:
 * every basic salary it has had, each from its date, and the compensations at its end. Adding a field
 * here needs no migration.
 */
export interface EmploymentPay {
  /** Oldest first. `effectiveFrom` is `YYYY-MM-DD`. */
  salaries: { effectiveFrom: string; amount: number; currency: string; byLaw?: boolean }[]
  compensations?: { code: string; amount: number }[]
}

const MODEL = 'EmploymentContract'
const PATH = 'pay'

export async function sealContractPay(orgId: unknown, contractId: string, pay: EmploymentPay): Promise<string> {
  return (await forOrg(orgId)).seal(MODEL, contractId, PATH, pay)
}

export async function openContractPay(orgId: unknown, doc: { id?: string; _id?: unknown; pay?: string | null }): Promise<EmploymentPay | null> {
  if (!doc.pay) return null
  return (await forOrg(orgId)).open<EmploymentPay>(MODEL, String(doc.id ?? doc._id), PATH, doc.pay)
}

/** The basic salary on a date, or null before the first. */
export function salaryAsOf(pay: EmploymentPay, date: string): EmploymentPay['salaries'][number] | null {
  let current: EmploymentPay['salaries'][number] | null = null
  for (const salary of pay.salaries) {
    if (salary.effectiveFrom <= date && (!current || salary.effectiveFrom >= current.effectiveFrom)) current = salary
  }
  return current
}
