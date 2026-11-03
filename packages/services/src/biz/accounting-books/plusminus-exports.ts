/**
 * FR-25 §5: the exports of the accountant's PlusMinus, read into what the import and the comparison
 * take. Import-pure: each parser takes a sheet as a matrix of cells (`scripts/lib/plusminus-sheet.ts`
 * reads the file), so a unit test needs no file.
 *
 * ⚠ The columns are found by their names, and the title block by its text: the layout changes between
 * exports of the same report (2023's journal has `Кол.` and `Номер`, 2026's `Кол`, `Журнал` and a
 * `Данък` column).
 *
 * ⚠ The guards matter more than the parsing, and each refuses rather than guesses:
 * - **A filtered export.** The same report filtered to one account or one customer looks the same,
 *   down to the file name, and has no document rows. A re-import replaces its months, so it would
 *   have replaced a whole month with one customer's payments. Only the title block's known lines are
 *   let through: anything else in it is a filter.
 * - **A count or a total the file itself contradicts.** It prints how many documents and operations
 *   it holds, and what they sum to.
 * - **Someone else's books.** The PC holds other companies'; the file says whose it is (`ЕИК:`), and
 *   the server compares that with the org's.
 */
import { EUR_CHANGEOVER } from './registry.js'
import type { ImportDocument, ImportOperation, LedgerCurrency } from './import.types.js'

export type Matrix = unknown[][]

export class ExportRefused extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExportRefused'
  }
}

export interface ExportPeriod {
  /** YYYY-MM-DD */
  from: string
  to: string
}

interface TitleBlock {
  lines: string[]
  period?: ExportPeriod
  currency?: LedgerCurrency
  eik?: string
  headerRow: number
}

const text = (v: unknown): string => {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}
const trimmed = (v: unknown): string => text(v).trim()

/** A cell as a number; blank is undefined; anything else that is no number stops the import. */
function num(v: unknown, where: string): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new ExportRefused('bad_number', `${where}: not a number`)
    return v
  }
  const s = String(v).trim()
  if (!s) return undefined
  const n = Number(s.replace(',', '.'))
  if (!Number.isFinite(n)) throw new ExportRefused('bad_number', `${where}: not a number`)
  return n
}

/**
 * `Курс`, and the amount in that currency. PlusMinus writes the text `NaN` on a row it computed no
 * rate for. Neither column is in any total, so that is a blank; `Сума` and `Кол.` keep refusing it.
 */
function fxCell(v: unknown, where: string): number | undefined {
  return trimmed(v) === 'NaN' ? undefined : num(v, where)
}

/** `31.12.2023` or a real date cell, as YYYY-MM-DD. Null when the cell is no date. */
function dateOf(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const m = /^(\d\d)\.(\d\d)\.(\d{4})$/.exec(trimmed(v))
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null
}

function firstText(row: unknown[]): string {
  for (const c of row) {
    const s = trimmed(c)
    if (s) return s
  }
  return ''
}

/** The title block: every line above the table's header row. */
function readTitleBlock(matrix: Matrix, isHeader: (row: unknown[]) => boolean): TitleBlock {
  const lines: string[] = []
  for (let i = 0; i < matrix.length; i++) {
    if (isHeader(matrix[i])) {
      const out: TitleBlock = { lines, headerRow: i }
      for (const line of lines) {
        const period = /^Период:\s*(\d\d\.\d\d\.\d{4})\s*-\s*(\d\d\.\d\d\.\d{4})/.exec(line)
        if (period) out.period = { from: dateOf(period[1])!, to: dateOf(period[2])! }
        if (/^Валута:\s*Лева/.test(line)) out.currency = 'BGN'
        if (/^Валута:\s*Евро/.test(line)) out.currency = 'EUR'
        const eik = /^ЕИК:\s*(\S+)/.exec(line)
        if (eik) out.eik = eik[1]
      }
      return out
    }
    const line = firstText(matrix[i])
    if (line) lines.push(line)
  }
  throw new ExportRefused('no_table', 'No table in this file: is it the right report?')
}

/** Lines of the title block that are none of `known`. On a journal, each is a filter. */
const unknownLines = (lines: string[], known: RegExp[]) => lines.filter(l => !known.some(re => re.test(l)))

// ── The journal („Отчет по журнал на операциите") ───────────────────────────────────────────────

const JOURNAL_LINES = [
  /^Отчет по журнал/, /^Период:/, /^Валута:/, /^Брой документи:/, /^Брой счетоводни операции:/, /^Фирма:/, /^ЕИК:/,
]

export interface ParsedJournal {
  eik?: string
  period: ExportPeriod
  /** What the file says its amounts are in. Unset: an older export, in the currency of its period. */
  currency?: LedgerCurrency
  /** Title-block lines that are not ours: a filter, whatever its wording. */
  filters: string[]
  documents: ImportDocument[]
  counts: { documents: number; operations: number }
  declared: { documents?: number; operations?: number }
}

/** A column by any of the names PlusMinus has given it. -1 when absent. */
function columnOf(header: unknown[], ...names: string[]): number {
  return header.findIndex(h => names.includes(trimmed(h)))
}

export function parseJournalExport(matrix: Matrix): ParsedJournal {
  const title = readTitleBlock(matrix, row => trimmed(row[0]) === 'Дата' && row.some(c => trimmed(c) === 'Сума'))
  if (!title.lines.some(l => /^Отчет по журнал/.test(l))) throw new ExportRefused('not_a_journal', 'This file is not „Отчет по журнал на операциите".')
  if (!title.period) throw new ExportRefused('no_period', 'The file does not say its period.')

  const header = matrix[title.headerRow]
  const c = {
    date: 0,
    doc: columnOf(header, 'Док.', 'Док'),
    no: columnOf(header, 'Док. N', 'Док. №'),
    d: columnOf(header, 'Дебит'),
    k: columnOf(header, 'Кредит'),
    ad: columnOf(header, 'Аналитичност дебит'),
    ak: columnOf(header, 'Аналитичност кредит'),
    qty: columnOf(header, 'Кол.', 'Кол'),
    cur: columnOf(header, 'Валута'),
    rate: columnOf(header, 'Курс'),
    fx: columnOf(header, 'Валута сума', 'Валутна сума'),
    sum: columnOf(header, 'Сума'),
    journal: columnOf(header, 'Журнал', 'Номер'),
    kind: columnOf(header, 'Вид'),
    tax: columnOf(header, 'Данък'),
    comment: columnOf(header, 'Коментар'),
  }
  for (const [name, i] of Object.entries(c)) {
    if (i < 0 && name !== 'tax') throw new ExportRefused('unknown_layout', `The journal has no column for "${name}".`)
  }

  const declared: ParsedJournal['declared'] = {}
  for (const line of title.lines) {
    const docs = /^Брой документи:\s*(\d+)/.exec(line)
    if (docs) declared.documents = Number(docs[1])
    const ops = /^Брой счетоводни операции:\s*(\d+)/.exec(line)
    if (ops) declared.operations = Number(ops[1])
  }

  const documents: ImportDocument[] = []
  let current: ImportDocument | null = null
  let documentCount = 0
  let operationCount = 0
  let operationsSum = 0
  let quantitySum = 0
  let headersSum = 0
  const footer: { all?: number; operations?: number; quantity?: number; operationCount?: number } = {}

  for (let i = title.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    if (!row.some(v => trimmed(v))) continue
    const at = `row ${i + 1}`
    const date = dateOf(row[c.date])
    if (!date) {
      // The two closing rows: their label is where the debit analytic would be.
      const label = trimmed(row[c.ad])
      const operations = /^Общо за счет\. операции \((\d+)\):?$/.exec(label)
      if (operations) {
        footer.operationCount = Number(operations[1])
        footer.operations = num(row[c.sum], at)
        footer.quantity = num(row[c.qty], at)
      } else if (label === 'Общо') {
        footer.all = num(row[c.sum], at)
      } else {
        throw new ExportRefused('unknown_row', `${at}: neither a date nor a total.`)
      }
      continue
    }

    const docType = trimmed(row[c.doc])
    const docNumber = trimmed(row[c.no])
    const d = trimmed(row[c.d])
    const k = trimmed(row[c.k])
    const amount = num(row[c.sum], at)

    if (!d && !k) {
      if (!docType && !docNumber) throw new ExportRefused('unknown_row', `${at}: a date, and nothing to book.`)
      documentCount++
      headersSum += amount ?? 0
      current = {
        date,
        docType,
        docNumber,
        ...(trimmed(row[c.kind]) ? { vatKind: trimmed(row[c.kind]) } : {}),
        ...(amount !== undefined ? { total: amount } : {}),
        ...(text(row[c.comment]).trim() ? { comment: text(row[c.comment]).trim() } : {}),
        ops: [],
      }
      documents.push(current)
      continue
    }
    if (!d || !k) throw new ExportRefused('one_sided_operation', `${at}: an operation with one account.`)

    const op: ImportOperation = { d, k, amount: amount ?? 0 }
    // Analytics exactly as booked: two paths that differ by a space are two rows in the trial balance.
    const ad = text(row[c.ad])
    const ak = text(row[c.ak])
    if (ad.trim()) op.ad = ad
    if (ak.trim()) op.ak = ak
    const qty = num(row[c.qty], at)
    if (qty !== undefined) op.qty = qty
    const cur = trimmed(row[c.cur])
    if (cur) op.cur = cur
    const rate = fxCell(row[c.rate], at)
    if (rate !== undefined) op.rate = rate
    const fx = fxCell(row[c.fx], at)
    if (fx !== undefined) op.fx = fx
    const comment = text(row[c.comment]).trim()
    if (comment) op.comment = comment
    const journal = trimmed(row[c.journal])
    if (journal) op.journal = journal
    const tax = c.tax >= 0 ? trimmed(row[c.tax]) : ''
    if (tax) op.tax = tax

    operationCount++
    operationsSum += op.amount
    quantitySum += qty ?? 0

    if (!docType && !docNumber) {
      // A row with no document is one entry of its own (monthly amortization, VAT, year-end).
      documents.push({ date, ops: [op] })
      current = null
      continue
    }
    // Its document's header came first, on every row of the year measured. One that did not means
    // an export of another shape: a filtered one has no headers at all.
    if (!current || current.docType !== docType || current.docNumber !== docNumber || current.date !== date) {
      throw new ExportRefused('operation_without_document', `${at}: an operation whose document has no header row.`)
    }
    current.ops.push(op)
  }

  const parsed: ParsedJournal = {
    eik: title.eik,
    period: title.period,
    currency: title.currency,
    filters: unknownLines(title.lines, JOURNAL_LINES),
    documents,
    counts: { documents: documentCount, operations: operationCount },
    declared,
  }

  if (declared.documents !== undefined && declared.documents !== documentCount) {
    throw new ExportRefused('count_mismatch', `The file says ${declared.documents} documents and holds ${documentCount}.`)
  }
  if (declared.operations !== undefined && declared.operations !== operationCount) {
    throw new ExportRefused('count_mismatch', `The file says ${declared.operations} operations and holds ${operationCount}.`)
  }
  if (footer.operationCount !== undefined && footer.operationCount !== operationCount) {
    throw new ExportRefused('count_mismatch', 'The closing row names another number of operations than the file holds.')
  }
  const offBy = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) > 0.005
  if (offBy(footer.operations, operationsSum)) throw new ExportRefused('total_mismatch', 'The operations do not sum to the total the file prints.')
  if (footer.quantity !== undefined && Math.abs(footer.quantity - quantitySum) > 0.0005) {
    throw new ExportRefused('total_mismatch', 'The quantities do not sum to the total the file prints.')
  }
  if (offBy(footer.all, operationsSum + headersSum)) throw new ExportRefused('total_mismatch', 'The rows do not sum to the total the file prints.')
  return parsed
}

/** A journal fit to replace months with: the whole of them, in one currency, in the currency of its dates. */
export function assertWholeJournal(j: ParsedJournal): void {
  if (j.filters.length) {
    throw new ExportRefused('filtered_export', `This export is filtered (${j.filters.length} filter line(s) in its title), and a re-import replaces whole months. Export the journal with no filter.`)
  }
  if (j.counts.operations > 0 && j.declared.documents === 0) {
    throw new ExportRefused('filtered_export', 'This export has no document rows. Export the journal with the documents.')
  }
  const beforeChangeover = j.period.to < EUR_CHANGEOVER
  const afterChangeover = j.period.from >= EUR_CHANGEOVER
  if (!beforeChangeover && !afterChangeover) {
    throw new ExportRefused('crosses_changeover', 'This export crosses 2026-01-01: BGN before it, EUR after. Export each year on its own.')
  }
  const expected: LedgerCurrency = beforeChangeover ? 'BGN' : 'EUR'
  const said = j.currency ?? expected
  if (said !== expected) {
    throw new ExportRefused('wrong_currency', `This export is in ${said}, and its period was booked in ${expected}. Export it in ${expected}: PlusMinus converts on reading, and the rounding cannot be undone.`)
  }
}

/** A journal's documents by the month they belong to, in file order. */
export function documentsByMonth(documents: ImportDocument[]): Map<string, ImportDocument[]> {
  const out = new Map<string, ImportDocument[]>()
  for (const doc of documents) {
    const month = doc.date.slice(0, 7)
    const list = out.get(month)
    if (list) list.push(doc)
    else out.set(month, [doc])
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)))
}

// ── The chart („Сметкоплан") ────────────────────────────────────────────────────────────────────

export interface ParsedChartRow {
  code: string
  name: string
  openingDebit: number
  openingCredit: number
  openingTurnoverDebit: number
  openingTurnoverCredit: number
}

export interface ParsedChart {
  eik?: string
  year: number
  rows: ParsedChartRow[]
}

export function parseChartExport(matrix: Matrix): ParsedChart {
  const title = readTitleBlock(matrix, row => trimmed(row[0]) === 'Код' && trimmed(row[1]) === 'Наименование')
  if (!title.lines.some(l => /^Сметкоплан/.test(l))) throw new ExportRefused('not_a_chart', 'This file is not „Сметкоплан".')
  const yearLine = title.lines.map(l => /^Година:\s*(\d{4})/.exec(l)).find(Boolean)
  if (!yearLine) throw new ExportRefused('no_period', 'The chart does not say its year.')

  const rows: ParsedChartRow[] = []
  for (let i = title.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    const code = trimmed(row[0])
    if (!code && !trimmed(row[1])) continue
    if (/^Съставител/.test(code)) continue
    const at = `row ${i + 1}`
    rows.push({
      code,
      name: trimmed(row[1]),
      openingDebit: num(row[2], at) ?? 0,
      openingCredit: num(row[3], at) ?? 0,
      openingTurnoverDebit: num(row[4], at) ?? 0,
      openingTurnoverCredit: num(row[5], at) ?? 0,
    })
  }
  return { eik: title.eik, year: Number(yearLine[1]), rows }
}

// ── The trial balance („Оборотна ведомост") ─────────────────────────────────────────────────────

export interface TrialBalanceCells {
  openingDebit: number
  openingCredit: number
  turnoverDebit: number
  turnoverCredit: number
  closingDebit: number
  closingCredit: number
}

export interface TrialBalanceQuantities {
  openingQuantity: number
  turnoverDebitQuantity: number
  turnoverCreditQuantity: number
  closingQuantity: number
}

export interface ParsedSyntheticRow extends TrialBalanceCells {
  code: string
  name: string
}

export interface ParsedAnalyticRow extends TrialBalanceCells, TrialBalanceQuantities {
  path: string
}

export type ParsedTrialBalance =
  | { kind: 'synthetic'; eik?: string; period: ExportPeriod; currency?: LedgerCurrency; filters: string[]; rows: ParsedSyntheticRow[]; total?: TrialBalanceCells }
  | { kind: 'analytic'; eik?: string; period: ExportPeriod; currency?: LedgerCurrency; filters: string[]; root?: string; rows: ParsedAnalyticRow[]; total?: TrialBalanceCells & TrialBalanceQuantities }

// The last two are the table's own group headers, in the row above its header row.
const TRIAL_BALANCE_LINES = [/^Оборотна ведомост/, /^Период:/, /^Валута:/, /^Фирма:/, /^ЕИК:/, /^Избрани АП:/, /^Сметка$/, /^Салдо в началото на периода$/]

export function parseTrialBalanceExport(matrix: Matrix): ParsedTrialBalance {
  const title = readTitleBlock(matrix, row => {
    const first = trimmed(row[0])
    return first === 'Аналитичен признак' || (first === 'Код' && trimmed(row[1]) === 'Име')
  })
  const heading = title.lines.find(l => /^Оборотна ведомост/.test(l))
  if (!heading) throw new ExportRefused('not_a_trial_balance', 'This file is not „Оборотна ведомост".')
  if (!title.period) throw new ExportRefused('no_period', 'The file does not say its period.')
  const filters = unknownLines(title.lines, TRIAL_BALANCE_LINES)
  const body = matrix.slice(title.headerRow + 1)

  if (trimmed(matrix[title.headerRow][0]) === 'Код') {
    const rows: ParsedSyntheticRow[] = []
    let total: TrialBalanceCells | undefined
    body.forEach((row, n) => {
      const at = `row ${title.headerRow + n + 2}`
      const code = trimmed(row[0])
      const cells = (): TrialBalanceCells => ({
        openingDebit: num(row[2], at) ?? 0,
        openingCredit: num(row[3], at) ?? 0,
        turnoverDebit: num(row[4], at) ?? 0,
        turnoverCredit: num(row[5], at) ?? 0,
        closingDebit: num(row[6], at) ?? 0,
        closingCredit: num(row[7], at) ?? 0,
      })
      if (/^Общо/.test(trimmed(row[1]))) total = cells()
      else if (/^\d/.test(code)) rows.push({ code, name: trimmed(row[1]), ...cells() })
    })
    return { kind: 'synthetic', eik: title.eik, period: title.period, currency: title.currency, filters, rows, total }
  }

  const rootLine = title.lines.map(l => /^Избрани АП:\s*(.*?):?\s*$/.exec(l)).find(Boolean)
  const rows: ParsedAnalyticRow[] = []
  let total: (TrialBalanceCells & TrialBalanceQuantities) | undefined
  body.forEach((row, n) => {
    const at = `row ${title.headerRow + n + 2}`
    const path = text(row[0])
    if (!path.trim() || /^Съставител/.test(path)) return
    const cells = {
      openingQuantity: num(row[1], at) ?? 0,
      openingDebit: num(row[2], at) ?? 0,
      openingCredit: num(row[3], at) ?? 0,
      turnoverDebitQuantity: num(row[4], at) ?? 0,
      turnoverCreditQuantity: num(row[5], at) ?? 0,
      turnoverDebit: num(row[6], at) ?? 0,
      turnoverCredit: num(row[7], at) ?? 0,
      closingQuantity: num(row[8], at) ?? 0,
      closingDebit: num(row[9], at) ?? 0,
      closingCredit: num(row[10], at) ?? 0,
    }
    if (/^Всичко/.test(path.trim())) total = cells
    else rows.push({ path, ...cells })
  })
  return { kind: 'analytic', eik: title.eik, period: title.period, currency: title.currency, filters, root: rootLine?.[1] || undefined, rows, total }
}

// ── The main book („Главна книга") ──────────────────────────────────────────────────────────────

export interface ParsedMainBookAccount {
  code: string
  name: string
  openingDebit: number
  openingCredit: number
  turnoverDebit: number
  turnoverCredit: number
  closingDebit: number
  closingCredit: number
  counters: { code: string; debit: number; credit: number }[]
}

export interface ParsedMainBook {
  eik?: string
  period: ExportPeriod
  currency?: LedgerCurrency
  filters: string[]
  accounts: ParsedMainBookAccount[]
}

const MAIN_BOOK_LINES = [/^Главна книга/, /^Период:/, /^Валута:/, /^Фирма:/, /^ЕИК:/]

export function parseMainBookExport(matrix: Matrix): ParsedMainBook {
  const title = readTitleBlock(matrix, row => trimmed(row[0]) === 'Сметка' && trimmed(row[1]) === 'Коресп. сметка')
  if (!title.lines.some(l => /^Главна книга/.test(l))) throw new ExportRefused('not_a_main_book', 'This file is not „Главна книга".')
  if (!title.period) throw new ExportRefused('no_period', 'The file does not say its period.')

  const accounts: ParsedMainBookAccount[] = []
  let current: ParsedMainBookAccount | null = null
  for (let i = title.headerRow + 1; i < matrix.length; i++) {
    const row = matrix[i]
    const at = `row ${i + 1}`
    const account = /^(\d+)\s*-\s*(.*)$/.exec(trimmed(row[0]))
    if (account) {
      current = { code: account[1], name: account[2], openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0, counters: [] }
      accounts.push(current)
      continue
    }
    const label = trimmed(row[1])
    if (!current || !label) continue
    const debit = num(row[2], at) ?? 0
    const credit = num(row[3], at) ?? 0
    const counter = /^(\d+)\s*-/.exec(label)
    if (counter) current.counters.push({ code: counter[1], debit, credit })
    else if (label === 'Начално салдо') { current.openingDebit = debit; current.openingCredit = credit }
    else if (label === 'Обороти през периода') { current.turnoverDebit = debit; current.turnoverCredit = credit }
    else if (label === 'Салдо в края на периода') { current.closingDebit = debit; current.closingCredit = credit }
  }
  return { eik: title.eik, period: title.period, currency: title.currency, filters: unknownLines(title.lines, MAIN_BOOK_LINES), accounts }
}

// ── The analytics (`ap_*.json`) ─────────────────────────────────────────────────────────────────

// CP1251 high range (0x80–0xFF) → Unicode, the encoding of the install's own files.
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ' + 'ђ‘’“”•–—�™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї' + '°±Ііґµ¶·ё№є»јЅѕї' +
  'АБВГДЕЖЗИЙКЛМНОП' + 'РСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмноп' + 'рстуфхцчшщъыьэюя'

function decodeCp1251(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP1251_HIGH[b - 0x80]
  return s
}

export interface AnalyticItem {
  path: string
  unit?: string
  /** ЕИК (`БУЛСТАТ`), or the digits of the VAT number. */
  taxId?: string
  vatNumber?: string
  address?: string
  city?: string
  phone?: string
  contactPerson?: string
  bankName?: string
  /** A foreign-currency bank account. */
  foreignCurrency?: boolean
}

const clean = (v: unknown) => String(v ?? '').trim()

/**
 * An `ap_*.json`, CP1251 or UTF-8. Group rows (`group: "true"`) are skipped: a group exists as soon
 * as a path under it does.
 *
 * ⚠ `ap_ПЕРСОНАЛ` holds employees, and the books do not need it (FR-25 §5): the one person-level
 * analytic in the journal is 425's, and it arrives with the journal. The file is refused, not read.
 */
export function parseAnalyticsFile(bytes: Uint8Array): AnalyticItem[] {
  const utf8 = new TextDecoder().decode(bytes).replace(/^﻿/, '')
  let raw: any[]
  try {
    if (utf8.includes('�')) throw new Error('not utf-8')
    raw = JSON.parse(utf8)
  } catch {
    raw = JSON.parse(decodeCp1251(bytes))
  }
  if (!Array.isArray(raw)) throw new ExportRefused('not_analytics', 'This file is not an analytics export.')

  const items: AnalyticItem[] = []
  for (const row of raw) {
    const path = clean(row?.ap)
    if (!path) continue
    if (path === 'ПЕРСОНАЛ' || path.startsWith('ПЕРСОНАЛ:')) {
      throw new ExportRefused('personal_data', 'ap_ПЕРСОНАЛ holds employees: the books do not need it, and it is not read.')
    }
    if (row.group) continue
    // ⚠ Each root's file spells its own columns: `МЯРКА` in one, `Банка` in another.
    const p = Object.fromEntries(Object.entries(row.params ?? {}).map(([key, value]) => [key.toLocaleUpperCase('bg'), value]))
    const item: AnalyticItem = { path }
    if (clean(p['МЯРКА'])) item.unit = clean(p['МЯРКА'])
    const vat = clean(p['ИНДДС'] || p['ИН ПО ДДС'])
    const eik = clean(p['БУЛСТАТ']) || vat.replace(/\D/g, '')
    if (eik) item.taxId = eik
    if (vat) item.vatNumber = vat
    if (clean(p['АДРЕС'])) item.address = clean(p['АДРЕС'])
    if (clean(p['ГРАД'])) item.city = clean(p['ГРАД']).replace(/^гр\.?\s*/i, '')
    if (clean(p['ТЕЛЕФОН'])) item.phone = clean(p['ТЕЛЕФОН'])
    if (clean(p['МОЛ'])) item.contactPerson = clean(p['МОЛ'])
    if (clean(p['БАНКА'])) item.bankName = clean(p['БАНКА'])
    if (row.currency === 'true' || row.currency === true) item.foreignCurrency = true
    items.push(item)
  }
  return items
}
