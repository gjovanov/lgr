import { decodeCp1251, encodeCp1251 } from 'config/cp1251'
import { money, quoted, splitRecord } from './csv.js'

/**
 * FR-25 §7.4: `EMPL2021.TXT`, обр. 1, one record per person per month. Import-pure.
 *
 * The spec is the NRA's of 2021-03-05, 53 fields. What the files on disk do beside it:
 * - an empty amount is `0.00`, where the spec asks for `0`;
 * - there is no Ctrl+Z at the end, where the spec asks for one. Filed files are the arbiter, so
 *   none is written unless asked for (`eof`).
 *
 * ⚠ A row holds a person's ЕГН and pay. It is parsed in memory, sealed when stored, and never logged.
 */
const CR_LF = '\r\n'
const CTRL_Z = '\x1a'

type Kind = 'int' | 'text' | 'money'

/** The record's 53 fields, in order. */
const FIELDS = [
  ['month', 'int'], ['year', 'int'], ['employerId', 'text'], ['personId', 'text'], ['personIdKind', 'int'],
  ['surname', 'text'], ['initials', 'text'], ['insuredType', 'int'],
  ['from1', 'int'], ['to1', 'int'], ['from2', 'int'], ['to2', 'int'], ['from3', 'int'], ['to3', 'int'],
  ['from4', 'int'], ['to4', 'int'], ['from5', 'int'], ['to5', 'int'],
  // Four characters: the days, two; statutory hours, one; contract hours a day, one (Н-13, т. 16).
  ['totalDays', 'text'],
  ['workedDays', 'int'], ['sickDays', 'int'], ['childcareDays', 'int'], ['noContributionDays', 'int'],
  ['unpaidLeaveDays', 'int'], ['employerSickDays', 'int'], ['hoursWorked', 'int'], ['overtimeHours', 'int'],
  ['qualificationGroup', 'int'], ['kid', 'text'], ['mainActivityRow', 'int'], ['summedTimeCode', 'text'],
  ['zoBaseSick', 'money'], ['zoRateSick', 'money'],
  ['insurableIncome', 'money'],
  ['dooRateEmployer', 'money'], ['dooRateEmployee', 'money'], ['zoRateEmployer', 'money'], ['zoRateEmployee', 'money'],
  ['tzpbRate', 'money'], ['uchpfRate', 'money'], ['ppfRate', 'money'], ['upfRateEmployer', 'money'], ['upfRateEmployee', 'money'],
  ['healthOnlyBase', 'money'], ['healthOnlyRate', 'money'],
  ['grossPay', 'money'], ['gvrsRate', 'money'], ['taxableIncome', 'money'], ['tax', 'money'], ['netPay', 'money'],
  ['kasaCode', 'int'], ['correctionCode', 'int'], ['developerId', 'text'],
] as const satisfies ReadonlyArray<readonly [string, Kind]>

type FieldName = (typeof FIELDS)[number][0]
type KindOf<N extends FieldName> = Extract<(typeof FIELDS)[number], readonly [N, Kind]>[1]

/** One record, in the spec's order and under its meaning. `month` is a number, `kid` a string. */
export type EmplRow = { [N in FieldName]: KindOf<N> extends 'text' ? string : number }

export const EMPL_FIELD_COUNT = FIELDS.length

/** A row that arrived over HTTP: every field present, under its kind, and no other. */
export function isEmplRow(row: unknown): row is EmplRow {
  if (typeof row !== 'object' || row === null) return false
  const fields = row as Record<string, unknown>
  if (Object.keys(fields).length !== FIELDS.length) return false
  return FIELDS.every(([name, kind]) => (kind === 'text' ? typeof fields[name] === 'string' : Number.isFinite(fields[name])))
}

function parseRecord(line: string): EmplRow {
  const raw = splitRecord(line)
  if (raw.length !== FIELDS.length) throw new Error(`обр. 1: a record has ${raw.length} fields, not ${FIELDS.length}`)
  const row: Record<string, string | number> = {}
  FIELDS.forEach(([name, kind], i) => {
    const { value, quoted: isQuoted } = raw[i]
    if (isQuoted !== (kind === 'text')) throw new Error(`обр. 1: field ${i + 1} is ${isQuoted ? 'quoted' : 'not quoted'}`)
    if (kind === 'text') { row[name] = value; return }
    const parsed = Number(value)
    if (value === '' || !Number.isFinite(parsed)) throw new Error(`обр. 1: field ${i + 1} is not a number`)
    row[name] = parsed
  })
  return row as EmplRow
}

export function parseEmpl(bytes: Uint8Array): EmplRow[] {
  const text = decodeCp1251(bytes).replace(/\x1a$/, '')
  return text.split(CR_LF).filter(line => line !== '').map(parseRecord)
}

export interface EmitEmplOptions {
  /** The EIK of LGR's maker (`PAYROLL_DEVELOPER_EIK`), which no file may be written without. */
  developerId: string
  /** Ctrl+Z after the last record, as the spec says. The files on disk have none. */
  eof?: boolean
}

function emitRecord(row: EmplRow, developerId: string): string {
  return FIELDS.map(([name, kind]) => {
    if (name === 'developerId') return quoted(developerId)
    const value = row[name]
    if (kind === 'text') return quoted(String(value).toUpperCase())
    return kind === 'money' ? money(value as number) : String(value)
  }).join(',')
}

export function emitEmpl(rows: readonly EmplRow[], options: EmitEmplOptions): Uint8Array {
  if (!options.developerId) throw new Error('обр. 1 needs the developer\'s EIK (PAYROLL_DEVELOPER_EIK)')
  const body = rows.map(row => `${emitRecord(row, options.developerId)}${CR_LF}`).join('')
  return encodeCp1251(options.eof ? `${body}${CTRL_Z}` : body)
}
