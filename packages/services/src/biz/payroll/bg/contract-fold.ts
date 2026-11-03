import type { ContractEvent } from './files/contract-events.js'
import { bgnWageToEur } from './money.js'

/**
 * FR-25 §5.1: from events on contracts to contracts. Import-pure. What the files do not say is listed
 * for the accountant and never guessed: a contract's first date, a salary, an annex that names a
 * contract the files do not hold.
 */
const EURO_DAY = '2026-01-01'
/** The personnel export of January 2026 still holds leva: the month's sheet is the first in euro. */
const LAST_EXPORT_IN_LEVA = '2026-01-31'

export interface PersonnelSnapshot {
  personId: string
  /** `YYYY-MM-DD`: when the export was made, the newest being the one believed. */
  asOf: string
  startDate?: string
  endDate?: string
  salary?: number
  hoursPerDay?: number
  statutoryHours?: number
  daysPerWeek?: number
  classPercent?: number
  experience?: { years: number; months: number; days: number }
  kid?: string
  nkpd?: string
  position?: string
  socialSecurityType?: string
  healthSecurityType?: string
  /** From обр. 1: its field 29, the qualification group and the annex's row. */
  activityKid?: string
  qualificationGroup?: number
  mainActivityRow?: number
}

export interface FoldedSalary {
  effectiveFrom: string
  amount: number
  currency: 'BGN' | 'EUR'
  byLaw?: boolean
}

export interface FoldedAmendment {
  date: string
  effectiveFrom: string
  kid?: string
  nkpd?: string
  byLaw?: boolean
}

export interface FoldedContract {
  personId: string
  date: string
  type?: string
  ekatte?: string
  startDate?: string
  endDate?: string
  position?: string
  nkpd?: string
  kid?: string
  activityKid?: string
  qualificationGroup?: number
  mainActivityRow?: number
  socialSecurityType: string
  healthSecurityType?: string
  hoursPerDay: number
  daysPerWeek: number
  statutoryHours: number
  annualLeaveDays?: number
  classPercent?: number
  experienceAtStart?: { years: number; months: number; days: number }
  amendments: FoldedAmendment[]
  termination?: { date: string; basis?: string; usedLeaveDays?: number; experience?: string; noExperience?: string }
  salaries: FoldedSalary[]
}

export type ContractGap = 'no_contract_event' | 'no_salary' | 'annex_without_contract' | 'termination_without_contract'

export interface FoldResult {
  contracts: FoldedContract[]
  /** Per person, by reason. The caller reports these as counts. */
  gaps: { personId: string; gap: ContractGap }[]
}

const currencyOn = (date: string): 'BGN' | 'EUR' => (date < EURO_DAY ? 'BGN' : 'EUR')
const currencyOfExport = (asOf: string): 'BGN' | 'EUR' => (asOf <= LAST_EXPORT_IN_LEVA ? 'BGN' : 'EUR')

/** A deletion takes its event out, a correction replaces it. */
function liveEvents(events: readonly ContractEvent[]): ContractEvent[] {
  const key = (e: ContractEvent) => `${e.source}|${e.action}|${e.contractDate}|${e.changeDate ?? ''}`
  const live = new Map<string, ContractEvent>()
  for (const event of events) {
    if (event.correction === 2) live.delete(key(event))
    else live.set(key(event), event)
  }
  return [...live.values()]
}

const eventDate = (e: ContractEvent) => e.endDate ?? e.effectiveFrom ?? e.changeDate ?? e.startDate ?? e.contractDate

/** What is known of a person from every export, the newest value of each field, and when it was so. */
interface MergedSnapshot extends PersonnelSnapshot {
  salaryAsOf?: string
}

function mergeSnapshots(snapshots: readonly PersonnelSnapshot[]): Map<string, MergedSnapshot> {
  const merged = new Map<string, MergedSnapshot>()
  for (const snapshot of [...snapshots].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
    const held = merged.get(snapshot.personId) ?? { personId: snapshot.personId, asOf: snapshot.asOf }
    const fresh = Object.fromEntries(Object.entries(snapshot).filter(([, value]) => value !== undefined))
    merged.set(snapshot.personId, { ...held, ...fresh, ...(snapshot.salary !== undefined ? { salaryAsOf: snapshot.asOf } : {}) })
  }
  return merged
}

function foldPerson(personId: string, events: ContractEvent[], snapshot: MergedSnapshot | undefined, out: FoldResult): void {
  const contracts = new Map<string, FoldedContract>()
  const hours = (e: ContractEvent) => (e.hoursCode === 1 && e.workingHours ? e.workingHours : 8)
  const ordered = [...events].sort((a, b) => eventDate(a).localeCompare(eventDate(b)))

  for (const event of ordered.filter(e => e.action === 'concluded')) {
    contracts.set(event.contractDate, {
      personId,
      date: event.contractDate,
      type: event.basis,
      ekatte: event.ekatte,
      startDate: event.startDate,
      nkpd: event.nkpd,
      kid: event.kid,
      socialSecurityType: '01',
      hoursPerDay: hours(event),
      daysPerWeek: 5,
      statutoryHours: 8,
      annualLeaveDays: event.leaveDays,
      amendments: [],
      salaries: event.salary === undefined ? [] : [{ effectiveFrom: event.startDate ?? event.contractDate, amount: event.salary, currency: currencyOn(event.startDate ?? event.contractDate) }],
    })
  }

  // The personnel export stands in for a contract older than the files, so that a termination or an
  // annex has something to land on: a person who left must not stay in force.
  if (snapshot?.startDate && !contracts.size) {
    contracts.set(snapshot.startDate, {
      personId,
      date: snapshot.startDate,
      startDate: snapshot.startDate,
      endDate: snapshot.endDate,
      socialSecurityType: snapshot.socialSecurityType ?? '01',
      hoursPerDay: snapshot.hoursPerDay ?? 8,
      daysPerWeek: snapshot.daysPerWeek ?? 5,
      statutoryHours: snapshot.statutoryHours ?? 8,
      amendments: [],
      salaries: [],
    })
  }

  for (const event of ordered) {
    if (event.action === 'concluded') continue
    const contract = contracts.get(event.contractDate) ?? [...contracts.values()].at(-1)
    if (!contract) {
      out.gaps.push({ personId, gap: event.action === 'amended' ? 'annex_without_contract' : 'termination_without_contract' })
      continue
    }
    if (event.action === 'amended') {
      const effectiveFrom = event.effectiveFrom ?? event.changeDate ?? event.contractDate
      contract.amendments.push({ date: event.changeDate ?? effectiveFrom, effectiveFrom, kid: event.kid, nkpd: event.nkpd })
      if (event.salary !== undefined) contract.salaries.push({ effectiveFrom, amount: event.salary, currency: currencyOn(effectiveFrom) })
    } else {
      contract.endDate = event.endDate
      contract.termination = { date: event.endDate ?? '', basis: event.endReason, usedLeaveDays: event.usedLeaveDays, experience: event.experience, noExperience: event.noExperience }
    }
  }

  // The personnel export fills what the events leave out.
  if (snapshot && contracts.size) {
    const last = [...contracts.values()].at(-1)!
    last.position ??= snapshot.position
    last.kid ??= snapshot.kid
    last.nkpd ??= snapshot.nkpd
    last.activityKid ??= snapshot.activityKid
    last.qualificationGroup ??= snapshot.qualificationGroup
    last.mainActivityRow ??= snapshot.mainActivityRow
    last.healthSecurityType ??= snapshot.healthSecurityType
    last.classPercent ??= snapshot.classPercent
    last.experienceAtStart ??= snapshot.experience
    last.startDate ??= snapshot.startDate
    // An export says what the salary was on its day, and nothing of since when: that is the date it gets.
    if (!last.salaries.length && snapshot.salary !== undefined) {
      const asOf = snapshot.salaryAsOf ?? snapshot.asOf
      last.salaries.push({ effectiveFrom: asOf, amount: snapshot.salary, currency: currencyOfExport(asOf) })
    }
  }

  if (!contracts.size) out.gaps.push({ personId, gap: 'no_contract_event' })
  for (const contract of contracts.values()) {
    if (!contract.salaries.length) out.gaps.push({ personId, gap: 'no_salary' })
    convertAtTheEuro(contract)
    out.contracts.push(contract)
  }
}

/**
 * FR-25 §5.1(6): a salary in leva on the day of the euro gets an amendment of that day, marked as
 * the law's, whether or not a paper annex exists. Wages round up (ЗВЕРБ чл. 45).
 */
function convertAtTheEuro(contract: FoldedContract): void {
  const salary = contract.salaries.at(-1)
  if (!salary || salary.currency !== 'BGN') return
  if (contract.endDate && contract.endDate < EURO_DAY) return
  // An export of January 2026 is still in leva, and dated after the day.
  const effectiveFrom = salary.effectiveFrom > EURO_DAY ? salary.effectiveFrom : EURO_DAY
  contract.salaries.push({ effectiveFrom, amount: bgnWageToEur(salary.amount), currency: 'EUR', byLaw: true })
  contract.amendments.push({ date: EURO_DAY, effectiveFrom, byLaw: true })
}

export function foldContractEvents(events: readonly ContractEvent[], snapshots: readonly PersonnelSnapshot[], people: readonly string[]): FoldResult {
  const byPerson = new Map<string, ContractEvent[]>()
  for (const event of liveEvents(events)) {
    if (!byPerson.has(event.personId)) byPerson.set(event.personId, [])
    byPerson.get(event.personId)!.push(event)
  }
  const known = mergeSnapshots(snapshots)
  const out: FoldResult = { contracts: [], gaps: [] }
  for (const personId of new Set([...people, ...byPerson.keys(), ...known.keys()])) {
    foldPerson(personId, byPerson.get(personId) ?? [], known.get(personId), out)
  }
  return out
}
