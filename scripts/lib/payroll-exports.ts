/**
 * FR-25 §5.1: the employer's Excel exports, read in memory by the vendor's column names. Their layout
 * changes with what a month had (leave, sick days, vouchers), so nothing here goes by position.
 *
 * ⚠ Prints nothing. A row holds a person's name and pay.
 */
import ExcelJS from 'exceljs'
import type { BgLine } from '../../packages/services/src/biz/payroll/bg/engine'
import type { PersonnelSnapshot } from '../../packages/services/src/biz/payroll/bg/contract-fold'
import type { SealedRoot } from './sealed-payroll'

const MONTHS: Readonly<Record<string, string>> = { ЯНУ: '01', ФЕВ: '02', МАР: '03', АПР: '04', МАЙ: '05', ЮНИ: '06', ЮЛИ: '07', АВГ: '08', СЕП: '09', ОКТ: '10', НОЕ: '11', ДЕК: '12' }

function cellText(cell: ExcelJS.Cell): string {
  const value: any = cell.value
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((t: any) => t.text).join('')
    if ('result' in value) return String(value.result ?? '')
    return ''
  }
  return String(value)
}

function rowCells(sheet: ExcelJS.Worksheet, row: number): string[] {
  const cells: string[] = []
  const line = sheet.getRow(row)
  for (let c = 1; c <= sheet.columnCount; c++) cells.push(cellText(line.getCell(c)).replace(/\s+/g, ' ').trim())
  return cells
}

async function firstSheet(bytes: Buffer): Promise<ExcelJS.Worksheet> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes as any)
  return book.worksheets[0]
}

/** `YYYYMMDD_HHMMSS` in an export's name: when it was made. */
const stampOf = (rel: string) => /_(\d{8})_\d{6}/.exec(rel)?.[1] ?? ''

const amountOf = (text: string) => {
  const value = Number(text.replace(',', '.'))
  return text !== '' && Number.isFinite(value) ? value : undefined
}

/** dd.mm.yyyy or an Excel date, as `YYYY-MM-DD`. */
function dateOf(text: string): string | undefined {
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text)
  if (dotted) return `${dotted[3]}-${dotted[2].padStart(2, '0')}-${dotted[1].padStart(2, '0')}`
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : undefined
}

/** `ГГ-ММ-ДД` or `ГГММДД`, length of service as the export writes it. */
function experienceOf(text: string): PersonnelSnapshot['experience'] {
  const digits = text.replace(/\D/g, '')
  if (digits.length !== 6) return undefined
  return { years: Number(digits.slice(0, 2)), months: Number(digits.slice(2, 4)), days: Number(digits.slice(4)) }
}

/** The vendor's name for a person, as one line: `Първо Второ Фамилия`. */
export interface PersonName {
  firstName: string
  middleName: string
  lastName: string
}

export function nameParts(name: string): PersonName {
  const parts = name.trim().split(/\s+/)
  return { firstName: parts[0] ?? '', middleName: parts.length > 2 ? parts.slice(1, -1).join(' ') : '', lastName: parts.length > 1 ? parts[parts.length - 1] : '' }
}

export interface PersonnelRow extends PersonnelSnapshot {
  name: string
}

/** `payrollEmployee_*.xlsx`: who is on the books on the day it was exported. */
export async function readPersonnel(root: SealedRoot): Promise<PersonnelRow[]> {
  const out: PersonnelRow[] = []
  for (const rel of root.list('exports').filter(f => f.includes('payrollEmployee'))) {
    const sheet = await firstSheet(root.open(rel))
    const stamp = stampOf(rel)
    const asOf = stamp ? `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` : ''
    let labels: string[] = []
    let header = -1
    for (let r = 1; r <= Math.min(sheet.rowCount, 15); r++) {
      const cells = rowCells(sheet, r)
      if (cells.includes('ЕГН/ЕНЧ')) { labels = cells; header = r; break }
    }
    if (header < 0) continue
    const at = (name: string) => labels.indexOf(name)
    for (let r = header + 1; r <= sheet.rowCount; r++) {
      const cells = rowCells(sheet, r)
      const get = (name: string) => (at(name) >= 0 ? cells[at(name)] : '')
      const personId = get('ЕГН/ЕНЧ')
      if (!/^\d{9,10}$/.test(personId)) continue
      out.push({
        name: get('ИМЕ'),
        personId,
        asOf,
        startDate: dateOf(get('Постъпил')),
        endDate: dateOf(get('Напуснал')),
        salary: amountOf(get('Осн. Заплата')),
        hoursPerDay: amountOf(get('Раб. време')),
        statutoryHours: amountOf(get('Законоуст. раб. време')),
        daysPerWeek: amountOf(get('Раб. седмица')),
        classPercent: amountOf(get('Клас')),
        experience: experienceOf(get('Осиг. Стаж')),
        kid: get('ТД КИД') || undefined,
        nkpd: get('ТД НКПД') || undefined,
        position: get('Длъжност') || undefined,
        socialSecurityType: get('Вид. Осиг.') || undefined,
        healthSecurityType: get('Вид. Здравно Осиг.') || undefined,
      })
    }
  }
  return out
}

export interface SheetRow {
  period: string
  name: string
  values: Record<string, number>
}

export interface SalarySheet {
  period: string
  /** `YYYYMMDD` of the export, so that the newest of a month wins. */
  stamp: string
  labels: string[]
  rows: SheetRow[]
}

const NOT_AMOUNTS = new Set(['', 'Име', 'No', 'Подпис'])

/** `payrollSalaries_*.xlsx`: the month's sheet. */
export async function readSalarySheets(root: SealedRoot): Promise<SalarySheet[]> {
  const out: SalarySheet[] = []
  for (const rel of root.list('exports').filter(f => f.includes('payrollSalaries'))) {
    const sheet = await firstSheet(root.open(rel))
    let period = ''
    let labels: string[] = []
    let header = -1
    for (let r = 1; r <= Math.min(sheet.rowCount, 15); r++) {
      const cells = rowCells(sheet, r)
      const title = /:\s*([А-Яа-я]{3})-(\d{4})/.exec(cells[0] ?? '')
      if (title && !period) period = `${title[2]}${MONTHS[title[1].toUpperCase()] ?? ''}`
      if (cells.includes('Име') && cells.includes('ФРЗ')) { labels = cells; header = r; break }
    }
    if (header < 0 || period.length !== 6) continue
    const name = labels.indexOf('Име')
    const rows: SheetRow[] = []
    for (let r = header + 1; r <= sheet.rowCount; r++) {
      const cells = rowCells(sheet, r)
      if (!/^\d+$/.test(cells[0] ?? '')) continue
      const values: Record<string, number> = {}
      labels.forEach((label, i) => {
        if (NOT_AMOUNTS.has(label)) return
        const amount = amountOf(cells[i])
        if (amount !== undefined) values[label] = amount
      })
      rows.push({ period, name: cells[name], values })
    }
    out.push({ period, stamp: stampOf(rel), labels, rows })
  }
  return out
}

const normal = (text: string) => text.toUpperCase().replace(/\s+/g, ' ').trim()

/** Surname and initials, the only name обр. 1 carries, from the sheet's full name. */
export function declarationKey(period: string, surname: string, initials: string): string {
  return `${period}|${normal(surname)}|${normal(initials)}`
}

export function sheetKey(row: SheetRow): string {
  const parts = normal(row.name).split(' ')
  const surname = parts[parts.length - 1]
  const initials = parts.slice(0, -1).map(p => p[0]).join('')
  return declarationKey(row.period, surname, initials)
}

/** A sheet row as a payslip's lines: what was paid, under our codes. */
export function sheetLines(row: SheetRow): BgLine[] {
  const line = (code: string, label: string, days?: string): BgLine[] => {
    const amount = row.values[label]
    if (!amount) return []
    return [{ code, amount, ...(days && row.values[days] ? { days: row.values[days] } : {}) }]
  }
  return [
    ...line('salary', 'Заплата', 'Отр. дни'),
    ...line('classSupplement', 'ДТВ за стаж'),
    ...line('paidLeave', 'Пл.отп. чл.155,ал.1', 'Платен отпуск'),
    ...line('employerSickPay', 'Болн. сума раб-л'),
  ]
}
