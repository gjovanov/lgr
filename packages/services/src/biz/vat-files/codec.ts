import { decodeCp1251, encodeCp1251 } from 'config/cp1251'
import {
  DEKLAR_LAYOUT, REGISTER_CODES, REGISTER_LAYOUT, SALES_CELLS, PURCHASE_CELLS, VIES_LAYOUT, layoutWidth,
  type FieldDef, type Layout, type VatSide, type ViesRecord,
} from './layouts.js'

/**
 * Parse and emit the NRA's VAT files, byte for byte (FR-25 §7.1, §7.2). Windows-1251, fixed width,
 * CRLF after every record. Text is left-aligned, numbers right-aligned, and a zero is blank, except
 * in VIES, which prints `0.00`. Amounts are integer cents, never floats.
 *
 * ⚠ It refuses rather than truncates: a value that does not fit its width, or a character outside
 * the code page, is a `VatFileError`. `encodeCp1251` on its own degrades (`é` → `e`, anything else →
 * `?`), which is right for a receipt and wrong for a return.
 *
 * ⚠ An error names the field and the record, never the value: these messages reach a terminal, a
 * log and a transcript, and the values are a company's partners and amounts.
 */
export class VatFileError extends Error {
  constructor(message: string, readonly field?: string, readonly record?: number) {
    super(message)
    this.name = 'VatFileError'
  }
}

/** A record's fields by code: a string for text, a number for a count and for cents. Blank is absent. */
export type FieldValues = Record<string, string | number | undefined>

/** Value cells by their official code, in cents. A blank cell has no key. */
export type VatCells = Record<string, number>

export interface VatRow {
  rowNo: number
  docTypeCode: string
  docNumber: string
  /** The document's calendar day, at UTC midnight. */
  docDate: Date
  partnerVat: string
  partnerName: string
  description: string
  branch?: number
  code: string
  cells: VatCells
}

export interface VatRegister {
  vatId: string
  /** `YYYYMM` */
  period: string
  rows: VatRow[]
}

export interface VatDeclaration {
  vatId: string
  name: string
  period: string
  filer: string
  salesRows: number
  purchaseRows: number
  cells: VatCells
}

/** The person who files the VIES declaration. `id` is an ЕГН or ЛНЧ: it stays out of every log. */
export interface VatViesDeclarant {
  id: string
  name: string
  city: string
  postcode: string
  address: string
  /** `A` an authorised agent, `R` a representative. */
  kind: string
}

export interface VatViesRow {
  rowNo: number
  /** The recipient's VAT id, with its country's letters. */
  partnerVat: string
  goods: number
  triangular: number
  services: number
  /** `MM/YYYY`, only where it is not the declaration's own period. */
  taxPeriod?: string
}

export interface VatCallOffRow {
  rowNo: number
  recipientVat: string
  operation: number
  replacedVat?: string
  taxPeriod?: string
}

export interface VatVies {
  period: string
  declarant: VatViesDeclarant
  company: { vatId: string; name: string; address: string }
  /** `TTR`: the base of everything, then of the goods alone. */
  total: number
  goods: number
  rows: VatViesRow[]
  callOff?: VatCallOffRow[]
}

const CRLF = '\r\n'
const MONEY = /^(-?)(\d+)(?:\.(\d{1,2}))?$/

/** `12.34` as 1234. Refuses what is not an amount in two decimals, which cents could not hold. */
export function parseMoney(raw: string, field?: string, record?: number): number {
  const m = MONEY.exec(raw)
  if (!m) throw new VatFileError(`${where(field, record)} is not an amount`, field, record)
  const cents = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new VatFileError(`${where(field, record)} is too large`, field, record)
  return m[1] ? -cents : cents
}

export function formatMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new VatFileError('An amount is not a whole number of cents')
  const abs = Math.abs(cents)
  return `${cents < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** `31/12/2026` as that day at UTC midnight. Refuses a day the calendar does not have. */
export function parseDocDate(raw: string, field?: string, record?: number): Date {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw)
  const day = m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : null
  if (!m || !day || day.getUTCMonth() !== Number(m[2]) - 1 || day.getUTCDate() !== Number(m[1])) {
    throw new VatFileError(`${where(field, record)} is not a date`, field, record)
  }
  return day
}

export function formatDocDate(day: Date): string {
  return `${String(day.getUTCDate()).padStart(2, '0')}/${String(day.getUTCMonth() + 1).padStart(2, '0')}/${day.getUTCFullYear()}`
}

function where(field?: string, record?: number): string {
  return `${field ?? 'A field'}${record ? ` in record ${record}` : ''}`
}

/** A character the file cannot carry: outside the code page, or a control that would split a record. */
function assertEncodable(value: string, field: string, record?: number): void {
  if (decodeCp1251(encodeCp1251(value)) === value && !/[\x00-\x1F\x7F]/.test(value)) return
  throw new VatFileError(`${where(field, record)} has a character Windows-1251 cannot carry`, field, record)
}

function fit(value: string, field: FieldDef, record?: number): string {
  if (value.length > field.width) throw new VatFileError(`${where(field.code, record)} does not fit its ${field.width} characters`, field.code, record)
  return value
}

function emitField(value: string | number | undefined, field: FieldDef, record?: number): string {
  if (field.kind === 'text') {
    const v = String(value ?? '')
    assertEncodable(v, field.code, record)
    return fit(v, field, record).padEnd(field.width, ' ')
  }
  if (value === undefined) return ' '.repeat(field.width)
  if (typeof value !== 'number') throw new VatFileError(`${where(field.code, record)} is not a number`, field.code, record)
  if (field.kind === 'count') {
    if (!Number.isSafeInteger(value) || value < 0) throw new VatFileError(`${where(field.code, record)} is not a count`, field.code, record)
    return fit(String(value), field, record).padStart(field.width, ' ')
  }
  if (value === 0 && field.zero !== 'printed') return ' '.repeat(field.width)
  return fit(formatMoney(value), field, record).padStart(field.width, ' ')
}

function parseField(raw: string, field: FieldDef, record?: number): string | number | undefined {
  // ⚠ Spaces only: `trim()` would take a no-break space, which the code page carries, and the text
  // inside a field stays as filed, double spaces included (32 partner names have them).
  if (field.kind === 'text') return raw.replace(/ +$/, '')
  const v = raw.trim()
  if (!v) return undefined
  if (field.kind === 'money') return parseMoney(v, field.code, record)
  if (!/^\d+$/.test(v)) throw new VatFileError(`${where(field.code, record)} is not a count`, field.code, record)
  return Number(v)
}

export function emitRecord(values: FieldValues, layout: Layout, record?: number): string {
  return layout.map(f => emitField(values[f.code], f, record)).join('')
}

export function parseRecord(line: string, layout: Layout, record?: number): FieldValues {
  const width = layoutWidth(layout)
  if (line.length !== width) throw new VatFileError(`Record ${record ?? 1} is ${line.length} characters, its layout ${width}`, undefined, record)
  const out: FieldValues = {}
  let at = 0
  for (const f of layout) {
    const v = parseField(line.slice(at, at + f.width), f, record)
    if (v !== undefined && v !== '') out[f.code] = v
    at += f.width
  }
  return out
}

/** A file's records. Empty for a register with no documents, which has no records. */
function recordsOf(bytes: Uint8Array): string[] {
  if (!bytes.length) return []
  const text = decodeCp1251(bytes)
  if (text.includes('�')) throw new VatFileError('The file has a byte Windows-1251 does not define')
  if (!text.endsWith(CRLF)) throw new VatFileError('The file does not end its last record with CRLF')
  return text.slice(0, -CRLF.length).split(CRLF)
}

function bytesOf(records: readonly string[]): Uint8Array {
  return records.length ? encodeCp1251(records.join(CRLF) + CRLF) : new Uint8Array(0)
}

/** Every value of a record shares one sign, or the NRA refuses the file (Приложение № 12). */
export function assertOneSign(cells: VatCells, record?: number): void {
  const values = Object.values(cells)
  if (values.some(v => v > 0) && values.some(v => v < 0)) {
    throw new VatFileError(`${record ? `Record ${record}` : 'A record'} mixes positive and negative values`, undefined, record)
  }
}

const cellCodes = (side: VatSide): readonly string[] => (side === 'sales' ? SALES_CELLS : PURCHASE_CELLS)

/** A cell its register has no column for would vanish from the return without a word, so it is refused. */
function assertKnownCells(side: VatSide, cells: VatCells, record: number): void {
  const known = cellCodes(side)
  const stray = Object.keys(cells).find(code => !known.includes(code))
  if (stray) throw new VatFileError(`Record ${record} has a cell its register does not: ${stray}`, stray, record)
}

export function emitRegister(side: VatSide, register: VatRegister): Uint8Array {
  const c = REGISTER_CODES[side]
  return bytesOf(register.rows.map((row, i) => {
    assertKnownCells(side, row.cells, i + 1)
    assertOneSign(row.cells, i + 1)
    return emitRecord({
      [c.vatId]: register.vatId, [c.period]: register.period, [c.branch]: row.branch, [c.rowNo]: row.rowNo,
      [c.docTypeCode]: row.docTypeCode, [c.docNumber]: row.docNumber, [c.docDate]: formatDocDate(row.docDate),
      [c.partnerVat]: row.partnerVat, [c.partnerName]: row.partnerName, [c.description]: row.description,
      ...row.cells, [c.code]: row.code,
    }, REGISTER_LAYOUT[side], i + 1)
  }))
}

export function parseRegister(side: VatSide, bytes: Uint8Array): VatRegister {
  const c = REGISTER_CODES[side]
  const register: VatRegister = { vatId: '', period: '', rows: [] }
  recordsOf(bytes).forEach((line, i) => {
    const record = i + 1
    const v = parseRecord(line, REGISTER_LAYOUT[side], record)
    const vatId = String(v[c.vatId] ?? ''), period = String(v[c.period] ?? '')
    if (i === 0) { register.vatId = vatId; register.period = period }
    if (vatId !== register.vatId || period !== register.period) {
      throw new VatFileError(`Record ${record} names another company or period than the first`, undefined, record)
    }
    const cells: VatCells = {}
    for (const code of cellCodes(side)) {
      const cents = v[code]
      if (typeof cents === 'number' && cents !== 0) cells[code] = cents
    }
    register.rows.push({
      rowNo: Number(v[c.rowNo]),
      docTypeCode: String(v[c.docTypeCode] ?? ''),
      docNumber: String(v[c.docNumber] ?? ''),
      docDate: parseDocDate(String(v[c.docDate] ?? ''), c.docDate, record),
      partnerVat: String(v[c.partnerVat] ?? ''),
      partnerName: String(v[c.partnerName] ?? ''),
      description: String(v[c.description] ?? ''),
      ...(typeof v[c.branch] === 'number' ? { branch: v[c.branch] as number } : {}),
      code: String(v[c.code] ?? ''),
      cells,
    })
  })
  return register
}

export function emitDeklar(d: VatDeclaration): Uint8Array {
  return bytesOf([emitRecord({
    '00-01': d.vatId, '00-02': d.name, '00-03': d.period, '00-04': d.filer, '00-05': d.salesRows, '00-06': d.purchaseRows, ...d.cells,
  }, DEKLAR_LAYOUT)])
}

export function parseDeklar(bytes: Uint8Array): VatDeclaration {
  const records = recordsOf(bytes)
  if (records.length !== 1) throw new VatFileError(`DEKLAR holds ${records.length} records, and may hold one`)
  const v = parseRecord(records[0], DEKLAR_LAYOUT)
  const cells: VatCells = {}
  for (const f of DEKLAR_LAYOUT) {
    const cents = v[f.code]
    if (f.kind === 'money' && typeof cents === 'number' && cents !== 0) cells[f.code] = cents
  }
  return {
    vatId: String(v['00-01'] ?? ''),
    name: String(v['00-02'] ?? ''),
    period: String(v['00-03'] ?? ''),
    filer: String(v['00-04'] ?? ''),
    salesRows: Number(v['00-05'] ?? 0),
    purchaseRows: Number(v['00-06'] ?? 0),
    cells,
  }
}

/** `202305` as VIES writes it, `05/2023`. */
export const viesPeriod = (period: string): string => `${period.slice(4, 6)}/${period.slice(0, 4)}`

const fromViesPeriod = (raw: string): string => (/^\d{2}\/\d{4}$/.test(raw) ? `${raw.slice(3)}${raw.slice(0, 2)}` : '')

export function emitVies(v: VatVies): Uint8Array {
  const record = (code: ViesRecord, values: FieldValues, n?: number) => emitRecord({ [`${code}-1`]: code, ...values }, VIES_LAYOUT[code], n)
  const lines = [
    record('VHR', { 'VHR-2': viesPeriod(v.period), 'VHR-3': v.rows.length }),
    record('VDR', {
      'VDR-2': v.declarant.id, 'VDR-3': v.declarant.name, 'VDR-4': v.declarant.city,
      'VDR-5': v.declarant.postcode, 'VDR-6': v.declarant.address, 'VDR-7': v.declarant.kind,
    }),
    record('VTR', { 'VTR-2': v.company.vatId, 'VTR-3': v.company.name, 'VTR-4': v.company.address }),
    record('TTR', { 'TTR-2': v.total, 'TTR-3': v.goods }),
    ...v.rows.map((r, i) => record('VIR', {
      'VIR-2': r.rowNo, 'VIR-3': r.partnerVat, 'VIR-4': r.goods, 'VIR-5': r.triangular, 'VIR-6': r.services, 'VIR-7': r.taxPeriod,
    }, i + 1)),
  ]
  if (v.callOff?.length) {
    lines.push(record('CHR', { 'CHR-2': v.callOff.length }))
    v.callOff.forEach((r, i) => lines.push(record('COS', {
      'COS-2': r.rowNo, 'COS-3': r.recipientVat, 'COS-4': r.operation, 'COS-5': r.replacedVat, 'COS-6': r.taxPeriod,
    }, i + 1)))
  }
  return bytesOf(lines)
}

export function parseVies(bytes: Uint8Array): VatVies {
  const parsed: Partial<Record<ViesRecord, FieldValues[]>> = {}
  recordsOf(bytes).forEach((line, i) => {
    const code = line.slice(0, 3) as ViesRecord
    if (!(code in VIES_LAYOUT)) throw new VatFileError(`Record ${i + 1} is of no VIES section`, undefined, i + 1)
    ;(parsed[code] ??= []).push(parseRecord(line, VIES_LAYOUT[code], i + 1))
  })
  const one = (code: ViesRecord): FieldValues => {
    if (parsed[code]?.length !== 1) throw new VatFileError(`VIES holds ${parsed[code]?.length ?? 0} ${code} records, and must hold one`)
    return parsed[code]![0]
  }
  const header = one('VHR'), declarant = one('VDR'), company = one('VTR'), totals = one('TTR')
  const rows = parsed.VIR ?? []
  if (Number(header['VHR-3'] ?? 0) !== rows.length) throw new VatFileError('VHR counts another number of VIR records than the file holds')
  const callOff = parsed.COS ?? []
  return {
    period: fromViesPeriod(String(header['VHR-2'] ?? '')),
    declarant: {
      id: String(declarant['VDR-2'] ?? ''), name: String(declarant['VDR-3'] ?? ''), city: String(declarant['VDR-4'] ?? ''),
      postcode: String(declarant['VDR-5'] ?? ''), address: String(declarant['VDR-6'] ?? ''), kind: String(declarant['VDR-7'] ?? ''),
    },
    company: { vatId: String(company['VTR-2'] ?? ''), name: String(company['VTR-3'] ?? ''), address: String(company['VTR-4'] ?? '') },
    total: Number(totals['TTR-2'] ?? 0),
    goods: Number(totals['TTR-3'] ?? 0),
    rows: rows.map(r => ({
      rowNo: Number(r['VIR-2'] ?? 0), partnerVat: String(r['VIR-3'] ?? ''), goods: Number(r['VIR-4'] ?? 0),
      triangular: Number(r['VIR-5'] ?? 0), services: Number(r['VIR-6'] ?? 0),
      ...(r['VIR-7'] ? { taxPeriod: String(r['VIR-7']) } : {}),
    })),
    ...(callOff.length ? {
      callOff: callOff.map(r => ({
        rowNo: Number(r['COS-2'] ?? 0), recipientVat: String(r['COS-3'] ?? ''), operation: Number(r['COS-4'] ?? 0),
        ...(r['COS-5'] ? { replacedVat: String(r['COS-5']) } : {}),
        ...(r['COS-6'] ? { taxPeriod: String(r['COS-6']) } : {}),
      })),
    } : {}),
  }
}
