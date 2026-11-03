import { decodeCp1251 } from 'config/cp1251'
import { splitRecord } from './csv.js'

/**
 * FR-25 §7.5: what the labour register was told, read back. Import-pure, and read-only: `ETZ*.xml`
 * is the електронен трудов запис since 2025-06-01, and `UTD62_*.txt` the чл. 62 КТ notification before
 * it, which LGR never generates. Each record is one event on one contract.
 *
 * The notification's layout is on no spec held here. Its 27 fields were read from the files, and only
 * what is used is named: the action in the second field, the names, the dates, salary and the codes.
 */
export type ContractAction = 'concluded' | 'amended' | 'terminated'

export interface ContractEvent {
  source: 'etz' | 'utd62'
  action: ContractAction
  /** 0 regular, 1 a correction, 2 a deletion of what was filed. */
  correction: number
  personId: string
  personIdKind: number
  firstName: string
  middleName: string
  lastName: string
  /** `YYYY-MM-DD`, like every date here. */
  contractDate: string
  /** The basis of the contract, as a code. */
  basis: string
  startDate?: string
  termDate?: string
  changeDate?: string
  effectiveFrom?: string
  salary?: number
  nkpd?: string
  kid?: string
  ekatte?: string
  /** 1: `workingHours` a day. 2: a week. */
  hoursCode?: number
  workingHours?: number
  leaveDays?: number
  usedLeaveDays?: number
  endDate?: string
  endReason?: string
  experience?: string
  noExperience?: string
}

const ETZ_ACTIONS: Readonly<Record<string, ContractAction>> = { 1: 'concluded', 2: 'amended', 3: 'terminated' }

function tagOf(block: string, name: string): string | undefined {
  return new RegExp(`<${name}>([^<]*)</${name}>`, 'i').exec(block)?.[1]?.trim() || undefined
}

const numberOf = (value: string | undefined) => (value === undefined ? undefined : Number(value))

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

/** One `ETZ<eik>.XML`: `etzemploy/contract/rowenum`, a record per event. */
export function parseEtz(bytes: Uint8Array): ContractEvent[] {
  const text = decodeCp1251(bytes)
  const events: ContractEvent[] = []
  for (const match of text.matchAll(/<rowenum>([\s\S]*?)<\/rowenum>/gi)) {
    const block = match[1]
    const tag = (name: string) => tagOf(block, name)
    const action = ETZ_ACTIONS[tag('documenttype') ?? '']
    if (!action) throw new Error('ЕТЗ: a record of an unknown document type')
    events.push(withoutUndefined<ContractEvent>({
      source: 'etz',
      action,
      correction: Number(tag('codecorrection') ?? 0),
      personId: tag('egn') ?? '',
      personIdKind: Number(tag('egntype') ?? 0),
      firstName: tag('firstname') ?? '',
      middleName: tag('secondname') ?? '',
      lastName: tag('thirdname') ?? '',
      contractDate: tag('contractdate') ?? '',
      basis: tag('contracttype') ?? '',
      startDate: tag('begindate'),
      termDate: tag('termdate'),
      changeDate: tag('changedate'),
      effectiveFrom: tag('entrydate'),
      salary: numberOf(tag('salary')),
      nkpd: tag('codenkpd'),
      kid: tag('codekid'),
      ekatte: tag('codeekatte'),
      hoursCode: numberOf(tag('codehours')),
      workingHours: numberOf(tag('workinghours')),
      leaveDays: numberOf(tag('vacationdays')),
      usedLeaveDays: numberOf(tag('usedvacation')),
      endDate: tag('enddate'),
      endReason: tag('endreason'),
      experience: tag('experience'),
      noExperience: tag('noexperience'),
    }))
  }
  return events
}

const UTD_ACTIONS: Readonly<Record<string, ContractAction>> = { 1: 'concluded', 2: 'amended', 3: 'terminated' }
const UTD_FIELDS = 27

function utdDate(day: string, month: string, year: string): string | undefined {
  if (!Number(day) || !Number(month) || !Number(year)) return undefined
  return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}

/** One `UTD62_*.txt`: comma-separated, a record per notification, ending in Ctrl+Z. */
export function parseUtd62(bytes: Uint8Array): ContractEvent[] {
  const text = decodeCp1251(bytes).replace(/\x1a/g, '')
  return text.split(/\r?\n/).filter(line => line.trim() !== '').map((line) => {
    const fields = splitRecord(line).map(f => f.value)
    if (fields.length !== UTD_FIELDS) throw new Error(`UTD62: a record has ${fields.length} fields, not ${UTD_FIELDS}`)
    const action = UTD_ACTIONS[fields[1]]
    if (!action) throw new Error('UTD62: a record of an unknown action')
    const dated = (at: number) => utdDate(fields[at], fields[at + 1], fields[at + 2])
    const contractDate = dated(9) ?? ''
    return withoutUndefined<ContractEvent>({
      source: 'utd62',
      action,
      correction: Number(fields[0]),
      personId: fields[3],
      personIdKind: Number(fields[4]),
      firstName: fields[5],
      middleName: fields[6],
      lastName: fields[7],
      contractDate,
      basis: fields[8],
      changeDate: action === 'amended' ? dated(12) : undefined,
      effectiveFrom: action === 'amended' ? dated(12) : undefined,
      salary: fields[15] ? Number(fields[15]) : undefined,
      nkpd: fields[19] || undefined,
      kid: fields[20] || undefined,
      ekatte: fields[21] || undefined,
      endDate: action === 'terminated' ? dated(22) : undefined,
      endReason: action === 'terminated' ? fields[25] || undefined : undefined,
    })
  })
}
