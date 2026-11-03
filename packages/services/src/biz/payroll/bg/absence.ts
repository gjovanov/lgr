import { forOrg } from '../../personal-data/personal-data.service.js'
import type { BgDays } from './engine.js'

/**
 * FR-25 §3.12: why a person was away, sealed on `AbsenceEntry.detail`. Sick leave is health data, so
 * the code and the document are never in clear.
 */
export type AbsenceCode = 'paidLeave' | 'incapacity' | 'employerSick' | 'childcare' | 'uncontributed' | 'unpaidLeave'

export const ABSENCE_CODES: readonly AbsenceCode[] = ['paidLeave', 'incapacity', 'employerSick', 'childcare', 'uncontributed', 'unpaidLeave']

export interface AbsenceDetail {
  code: AbsenceCode
  document?: string
}

const MODEL = 'AbsenceEntry'
const PATH = 'detail'

export async function sealAbsenceDetail(orgId: unknown, entryId: string, detail: AbsenceDetail): Promise<string> {
  return (await forOrg(orgId)).seal(MODEL, entryId, PATH, detail)
}

export async function openAbsenceDetail(orgId: unknown, doc: { id?: string; _id?: unknown; detail?: string | null }): Promise<AbsenceDetail | null> {
  if (!doc.detail) return null
  return (await forOrg(orgId)).open<AbsenceDetail>(MODEL, String(doc.id ?? doc._id), PATH, doc.detail)
}

/**
 * A month's days from what is on record: the working days of the contract's span, less the absences,
 * each under its day code. More absent days than working days is a mistake in the entries, and the
 * worked days do not go below zero to hide it.
 */
export function daysFromAbsences(workingDays: number, absences: readonly { code: AbsenceCode; workingDays: number }[]): BgDays {
  const days: BgDays = { worked: 0, paidLeave: 0, incapacity: 0, childcare: 0, uncontributed: 0, unpaidLeave: 0, employerSick: 0 }
  for (const absence of absences) days[absence.code] += absence.workingDays
  const absent = absences.reduce((sum, a) => sum + a.workingDays, 0)
  if (absent > workingDays) throw new Error('more days of absence than working days in the month')
  days.worked = workingDays - absent
  return days
}
