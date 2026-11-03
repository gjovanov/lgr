import type { ContractEvent } from './files/contract-events.js'
import { bgnWageToEur } from './money.js'

/**
 * FR-25 §5.1: from events on contracts to contracts. Import-pure. What the files do not say is listed
 * for the accountant and never guessed: a contract's first date, a salary, an annex that names a
 * contract the files do not hold.
 */
const EURO_DAY = '2026-01-01'

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

/** Before the euro a salary is in leva. A deletion takes its event out, a correction replaces it. */
const currencyOn = (date: string): 'BGN' | 'EUR' => (date < EURO_DAY ? 'BGN' : 'EUR')

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

function foldPerson(personId: string, events: ContractEvent[], snapshot: PersonnelSnapshot | undefined, out: FoldResult): void {
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

  // The personnel export fills what the events leave out, and stands in for a contract that has none.
  if (snapshot) {
    if (!contracts.size) {
      if (!snapshot.startDate) {
        out.gaps.push({ personId, gap: 'no_contract_event' })
        return
      }
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
        salaries: snapshot.salary === undefined ? [] : [{ effectiveFrom: snapshot.startDate, amount: snapshot.salary, currency: currencyOn(snapshot.asOf) }],
      })
    }
    const last = [...contracts.values()].at(-1)!
    last.position ??= snapshot.position
    last.kid ??= snapshot.kid
    last.nkpd ??= snapshot.nkpd
    last.healthSecurityType ??= snapshot.healthSecurityType
    last.classPercent ??= snapshot.classPercent
    last.experienceAtStart ??= snapshot.experience
    last.startDate ??= snapshot.startDate
    if (!last.salaries.length && snapshot.salary !== undefined) {
      last.salaries.push({ effectiveFrom: last.startDate ?? last.date, amount: snapshot.salary, currency: currencyOn(snapshot.asOf) })
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
  const salary = contract.salaries.filter(s => s.effectiveFrom <= EURO_DAY).at(-1)
  if (!salary || salary.currency !== 'BGN') return
  if (contract.endDate && contract.endDate < EURO_DAY) return
  if (contract.salaries.some(s => s.effectiveFrom >= EURO_DAY && s.currency === 'EUR')) return
  contract.salaries.push({ effectiveFrom: EURO_DAY, amount: bgnWageToEur(salary.amount), currency: 'EUR', byLaw: true })
  contract.amendments.push({ date: EURO_DAY, effectiveFrom: EURO_DAY, byLaw: true })
}

export function foldContractEvents(events: readonly ContractEvent[], snapshots: readonly PersonnelSnapshot[], people: readonly string[]): FoldResult {
  const byPerson = new Map<string, ContractEvent[]>()
  for (const event of liveEvents(events)) {
    if (!byPerson.has(event.personId)) byPerson.set(event.personId, [])
    byPerson.get(event.personId)!.push(event)
  }
  const newest = new Map<string, PersonnelSnapshot>()
  for (const snapshot of snapshots) {
    const held = newest.get(snapshot.personId)
    if (!held || snapshot.asOf > held.asOf) newest.set(snapshot.personId, snapshot)
  }
  const out: FoldResult = { contracts: [], gaps: [] }
  for (const personId of new Set([...people, ...byPerson.keys(), ...newest.keys()])) {
    foldPerson(personId, byPerson.get(personId) ?? [], newest.get(personId), out)
  }
  return out
}
