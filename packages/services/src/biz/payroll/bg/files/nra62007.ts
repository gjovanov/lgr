import { decodeCp1251, encodeCp1251 } from 'config/cp1251'
import { money, quoted, splitRecord } from './csv.js'

/**
 * FR-25 §7.4: `NRA62007.TXT`, обр. 6, the month's totals: one record of 59 fields. Import-pure.
 *
 * The spec is the NRA's of 2013-01-02, still citing Н-8. Empty stays empty here, unlike обр. 1. Four
 * columns of 13 follow the header; on disk the first is the month's contributions (payment type 5)
 * and the second the withheld tax (8, which the 2013 spec does not list). So the tax on a month's
 * обр. 6 is the previous month's, while its contributions are that month's own (§1.8).
 *
 * The files on disk end the record two ways: `CR LF Ctrl+Z`, as the spec says, and, in 2023's,
 * Ctrl+Z straight after the last field. A parsed file says which, so that it can be re-emitted.
 */
const CR_LF = '\r\n'
const CTRL_Z = '\x1a'
const COLUMNS = 4
const HEADER_FIELDS = 6
const COLUMN_FIELDS = 13
export const NRA_FIELD_COUNT = HEADER_FIELDS + COLUMNS * COLUMN_FIELDS + 1

export interface NraColumn {
  /** Two digits, and the year four: these are written as they stand. */
  month: string
  year: string
  /** `dd/mm/yyyy`. */
  paymentDate: string
  changeFlag: string
  paymentType: string
  doo: number | null
  uchpf: number | null
  dzpoUpf: number | null
  dzpoPpf: number | null
  zo: number | null
  gvrs: number | null
  tax: number | null
  advanceTax: number | null
}

export interface NraRecord {
  employerId: string
  employerName: string
  kasaMember: number
  email: string
  phone: string
  gsm: string
  columns: NraColumn[]
  developerId: string
}

export type NraEnding = 'crlf-eof' | 'eof'

export interface NraFile {
  record: NraRecord
  ending: NraEnding
}

const AMOUNTS = ['doo', 'uchpf', 'dzpoUpf', 'dzpoPpf', 'zo', 'gvrs', 'tax', 'advanceTax'] as const

function amount(value: string, field: number): number | null {
  if (value === '') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`обр. 6: field ${field} is not a number`)
  return parsed
}

function parseColumn(raw: { value: string }[], start: number): NraColumn {
  const [month, year, paymentDate, changeFlag, paymentType] = raw.slice(start, start + 5).map(f => f.value)
  const column: NraColumn = {
    month, year, paymentDate, changeFlag, paymentType,
    doo: null, uchpf: null, dzpoUpf: null, dzpoPpf: null, zo: null, gvrs: null, tax: null, advanceTax: null,
  }
  AMOUNTS.forEach((name, i) => { column[name] = amount(raw[start + 5 + i].value, start + 6 + i) })
  return column
}

export function parseNra(bytes: Uint8Array): NraFile {
  const text = decodeCp1251(bytes)
  if (!text.endsWith(CTRL_Z)) throw new Error('обр. 6: the file does not end in Ctrl+Z')
  const ending: NraEnding = text.endsWith(`${CR_LF}${CTRL_Z}`) ? 'crlf-eof' : 'eof'
  const lines = text.slice(0, ending === 'eof' ? -1 : -3).split(CR_LF)
  if (lines.length !== 1) throw new Error(`обр. 6: ${lines.length} records, not one`)
  const raw = splitRecord(lines[0])
  if (raw.length !== NRA_FIELD_COUNT) throw new Error(`обр. 6: a record has ${raw.length} fields, not ${NRA_FIELD_COUNT}`)
  return {
    ending,
    record: {
      employerId: raw[0].value,
      employerName: raw[1].value,
      kasaMember: Number(raw[2].value),
      email: raw[3].value,
      phone: raw[4].value,
      gsm: raw[5].value,
      columns: Array.from({ length: COLUMNS }, (_, c) => parseColumn(raw, HEADER_FIELDS + c * COLUMN_FIELDS)),
      developerId: raw[NRA_FIELD_COUNT - 1].value,
    },
  }
}

const optionalText = (value: string) => (value === '' ? '' : quoted(value))
const optionalMoney = (value: number | null) => (value === null ? '' : money(value))

function emitColumn(column: NraColumn): string[] {
  return [column.month, column.year, column.paymentDate, column.changeFlag, column.paymentType, ...AMOUNTS.map(name => optionalMoney(column[name]))]
}

export interface EmitNraOptions {
  /** The EIK of LGR's maker (`PAYROLL_DEVELOPER_EIK`), which no file may be written without. */
  developerId: string
  /** Defaults to the spec's ending. */
  ending?: NraEnding
}

export function emitNra(record: NraRecord, options: EmitNraOptions): Uint8Array {
  if (!options.developerId) throw new Error('обр. 6 needs the developer\'s EIK (PAYROLL_DEVELOPER_EIK)')
  if (record.columns.length !== COLUMNS) throw new Error(`обр. 6 has ${COLUMNS} columns`)
  const fields = [
    optionalText(record.employerId), optionalText(record.employerName), String(record.kasaMember),
    optionalText(record.email), optionalText(record.phone), optionalText(record.gsm),
    ...record.columns.flatMap(emitColumn),
    quoted(options.developerId),
  ]
  const ending = (options.ending ?? 'crlf-eof') === 'crlf-eof' ? `${CR_LF}${CTRL_Z}` : CTRL_Z
  return encodeCp1251(`${fields.join(',')}${ending}`)
}
