import { orgLocalParts } from '../digest/digest-time.js'
import { graceEndsAt, type LicenceClaims, type LicencePlan, type VerifyFailure } from './licence-token.js'

/**
 * FR-20.55 — where a master's licence for an org stands, on the org's own calendar.
 *
 * - **licensed** until the paid-through date;
 * - **grace** for 30 days after it, with nothing blocked (a banner says so);
 * - **restricted** from the first local midnight after the grace ends: no new sale at the till and no
 *   new sales documents (`licence-gate.ts`). Never in the middle of a day, so never in the middle of
 *   a sale or of an open session;
 * - **evaluation**: an org with no licence here works for 30 days from the master's first start, then
 *   is restricted the same way.
 *
 * A licence that is present but unusable (another org's, another master's, a bad signature) counts as
 * none, and the status says why.
 *
 * Import-pure.
 */

export const EVALUATION_DAYS = 30

export type LicenceState = 'licensed' | 'grace' | 'evaluation' | 'restricted'
export type LicenceProblem = VerifyFailure | 'other_org' | 'other_node'

export interface LicenceStatus {
  applies: true
  state: LicenceState
  /** What the dates come from: a licence, or the evaluation period. */
  basis: 'licence' | 'evaluation'
  plan?: LicencePlan
  paidThrough?: string
  issuedAt?: string
  /** When the grace (a licence) or the evaluation ends. */
  endsAt: string
  /** The first day, on the org's calendar, on which new sales and documents are refused. */
  restrictedFrom: string
  /** Calendar days from today to `restrictedFrom`; 0 once restricted. */
  daysLeft: number
  /** A licence that is there and was not used, and why. */
  problem?: LicenceProblem
}

/** The calendar day after `localDate` (YYYY-MM-DD). Date-only arithmetic, in UTC on purpose. */
export function nextLocalDate(localDate: string): string {
  const [y, m, d] = localDate.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
  const at = (s: string) => {
    const [y, m, d] = s.split('-').map(Number)
    return Date.UTC(y, m - 1, d)
  }
  return Math.round((at(to) - at(from)) / 86_400_000)
}

export function licenceStatus(input: {
  claims: LicenceClaims | null
  problem?: LicenceProblem
  now: Date
  /** The org's IANA zone. Unset or invalid is UTC (`orgLocalParts`). */
  timezone: string | undefined
  /** The master's first start: where an evaluation counts from. */
  evaluationStart: Date
}): LicenceStatus {
  const { claims, now, timezone } = input
  const today = orgLocalParts(now, timezone).date
  const endsAt = claims ? graceEndsAt(claims) : new Date(input.evaluationStart.getTime() + EVALUATION_DAYS * 86_400_000)
  const restrictedFrom = nextLocalDate(orgLocalParts(endsAt, timezone).date)
  const state: LicenceState =
    today >= restrictedFrom ? 'restricted'
      : !claims ? 'evaluation'
        : now.getTime() < Date.parse(claims.paidThrough) ? 'licensed'
          : 'grace'
  return {
    applies: true,
    state,
    basis: claims ? 'licence' : 'evaluation',
    ...(claims ? { plan: claims.plan, paidThrough: claims.paidThrough, issuedAt: new Date(claims.iat * 1000).toISOString() } : {}),
    endsAt: endsAt.toISOString(),
    restrictedFrom,
    daysLeft: Math.max(0, daysBetween(today, restrictedFrom)),
    ...(input.problem ? { problem: input.problem } : {}),
  }
}
